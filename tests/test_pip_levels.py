"""How much a Personal Pip asks (pip_levels, Pips API 58): Ask (as before), Approve for me (routine steps go by
themselves, consequential ones ask) and Full access (everything but payments), with the safety floor, sites from the
user's own documents, and a record of everything a level let through."""
import base64
import hashlib
import http.server
import json
import re
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_careful, pip_chat, pip_computer, pip_computer_box as box, pip_levels as levels, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures
from tests.test_pip_chat_files import docx, uri
from tests.test_pip_computer_box import TEST_HOST

REAL_CHROME = box.find_chrome()          # before the fixture moves HOME
PLAN = {"schema_version": 1}


def pdf(text: str) -> bytes:
    """A one-page PDF whose text is `text` (pypdf reads it back)."""
    content = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
               b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)


class Store(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def personal(self, computer=False):
        pip = self.store.create(self.registry.personal()["id"], "Bill Payer", "Pay my bills", "editor-user")
        if computer:
            proposal = self.store.propose(pip["id"], 1, {"computer_plan": PLAN}, "local-console")
            self.store.accept(pip["id"], proposal["id"], 1, "local-console")
        return self.store.get(pip["id"])

    def control(self, command, actor="editor-user", **fields):
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
            response = pips.handle_control(self.cfg, {"type": command, "request_id": "r1", **fields}, actor, start_worker=False)
        if not response.get("ok"):
            raise RegistryError(response["error"]["code"], response["error"]["message"])
        return response["result"]


class LevelSettingTests(Store):
    def test_pips_api_58_offers_the_level_and_it_starts_at_ask_for_every_pip(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 58)
        self.assertEqual(levels.DEFAULT, levels.ASK, "no silent change: a Pip nobody chose for asks as before")
        pip = self.personal()
        got = self.control("get_pip_level", pip_id=pip["id"])
        self.assertEqual((got["pip_id"], got["level"], got["default"], got["on_its_own"]), (pip["id"], "ask", "ask", []))
        self.assertEqual([(l["level"], l["name"]) for l in got["levels"]],
                         [("ask", "Ask"), ("approve", "Approve for me"), ("full", "Full access")])
        for line in (l["says"] for l in got["levels"]):
            self.assertLess(len(line), 160, "one plain line a level")
            self.assertNotRegex(line, r"\bAI\b")
        self.assertIn("payment", got["levels"][2]["says"])

    def test_a_personal_pip_made_now_starts_at_approve_for_me_and_one_made_before_keeps_ask(self):
        # Reported 2026-10-21: new Personal Pips start at Approve for me; existing ones stay at Ask.
        self.cfg.data["pips_enabled"] = True
        before = self.personal()                                   # made before: nothing saved for it
        made = self.control("create_pip", workspace_id=self.registry.personal()["id"], name="Shopper",
                            goal="Order things I ask for", computer=False)["pip"]
        self.assertEqual(levels.level(self.registry, made["id"]), "approve")
        self.assertEqual(levels.level(self.registry, before["id"]), "ask")
        project = self.control("create_pip", workspace_id=self.workspace["id"], name="Reviewer", goal="Review")["pip"]
        self.assertEqual(levels.level(self.registry, project["id"]), "ask", "a Project Pip always asks")
        self.control("set_pip_level", pip_id=made["id"], level="ask")
        with self.registry.transaction():
            levels.start(self.registry, made["id"])
        self.assertEqual(levels.level(self.registry, made["id"]), "ask", "a level someone chose is never replaced")

    def test_only_you_set_it_on_this_computer_for_a_personal_pip(self):
        pip = self.personal()
        with self.assertRaises(RegistryError) as raised:
            self.control("set_pip_level", actor="device_1", pip_id=pip["id"], level="full")
        self.assertEqual(raised.exception.code, "local_only")
        with self.assertRaises(RegistryError) as raised:
            self.control("set_pip_level", pip_id=pip["id"], level="yolo")
        self.assertEqual(raised.exception.code, "invalid_request")
        with self.assertRaises(RegistryError):
            self.control("set_pip_level", pip_id=pip["id"], level="full", extra=1)
        self.assertEqual(self.control("set_pip_level", pip_id=pip["id"], level="approve")["level"], "approve")
        self.assertEqual(levels.level(self.registry, pip["id"]), "approve")
        changed = self.registry.db.execute("SELECT payload FROM workspace_events WHERE event_type='pip_level_changed'").fetchall()
        self.assertEqual(json.loads(changed[-1][0])["level"], "approve")
        project = self.store.create(self.workspace["id"], "Reviewer", "Review", "editor-user")
        with self.assertRaises(RegistryError):
            levels.set_level(self.registry, project["id"], "full", "editor-user")
        self.assertEqual(levels.level(self.registry, project["id"]), "ask", "a Project Pip always asks")

    def test_each_level_tells_the_pip_what_goes_through_and_ask_tells_it_nothing_new(self):
        self.assertEqual(levels.instructions("ask"), "")
        approve, full = levels.instructions("approve"), levels.instructions("full", drafting=True, unattended=True)
        self.assertIn("carry on without stopping", approve)
        self.assertIn("Placing an order, a payment, sending to someone new", approve)
        self.assertIn("A payment still waits for the user", full)
        self.assertIn("sends your drafts without asking", full)
        self.assertIn("Nobody is at the keyboard", full)


class ClassifyTests(unittest.TestCase):
    def verdict(self, **cues):
        return levels.classify({"method": "POST", "host": "shop.example", "path": "/", "fields": [], **cues})["verdict"]

    def test_routine_steps_are_named_by_what_was_pressed_the_address_and_the_field_names(self):
        for cues in ({"target": "Add to cart", "path": "/api/cart", "fields": ["item", "qty"]},
                     {"target": "", "path": "/search", "fields": ["q"]},
                     {"target": "Accept all cookies", "path": "/consent"},
                     {"target": "Save draft", "path": "/drafts", "fields": ["body"]},
                     {"target": "Apply filters", "path": "/results"},
                     {"target": "", "path": "/upload", "fields": ["file"], "upload": "bill-1.jpg"},
                     {"target": "", "buttons": ["Update cart"], "path": "/cart"}):
            with self.subTest(cues=cues):
                self.assertEqual(self.verdict(**cues), "routine")
        self.assertEqual(levels.classify({"method": "POST", "host": "shop.example", "path": "/api/cart", "fields": [],
                                          "target": "Add to cart"})["what"], "Added to cart on shop.example")

    def test_consequential_and_payments_ask_and_unsure_is_not_routine(self):
        for cues, expected in (({"target": "Place order · Pay ₹6,980", "path": "/api/order", "fields": ["order"]}, "payment"),
                               ({"target": "Pay with saved card", "path": "/pay-saved", "fields": ["card_token"]}, "payment"),
                               ({"target": "Continue", "path": "/next", "fields": ["amount"]}, "payment"),
                               ({"target": "Subscribe", "path": "/newsletter", "fields": ["email"]}, "payment"),
                               ({"target": "", "buttons": ["Add to cart", "Buy now"], "path": "/cart/add"}, "payment"),
                               ({"payment": True, "target": "Search"}, "payment"),
                               ({"target": "Send", "path": "/compose", "fields": ["to", "body"]}, "consequential"),
                               ({"target": "Post", "path": "/comments", "fields": ["body"]}, "consequential"),
                               ({"target": "Delete", "path": "/items/3"}, "consequential"),
                               ({"method": "DELETE", "path": "/items/3"}, "consequential"),
                               ({"target": "Save", "path": "/account/password", "fields": ["new_password"]}, "consequential"),
                               ({"target": "Book now", "path": "/slots"}, "consequential"),
                               ({"target": "Proceed to checkout", "path": "/cart"}, "consequential"),
                               ({"target": "Continue", "path": "/step", "fields": ["x"]}, "unsure")):
            with self.subTest(cues=cues):
                self.assertEqual(self.verdict(**cues), expected)

    def test_a_graphql_request_is_judged_by_its_operation_not_by_its_query_field(self):
        base = {"method": "POST", "host": "shop.example", "path": "/graphql", "fields": ["operationName", "variables", "query"], "target": ""}
        def verdict(operation, query):
            return levels.classify({**base, "values": {"operationName": operation, "query": query}})["verdict"]
        self.assertEqual(verdict("ProductSearch", "query ProductSearch($q: String) { products(q: $q) { id } }"), "routine")
        self.assertEqual(verdict("AddToCart", "mutation AddToCart($id: ID!) { addToCart(id: $id) { id } }"), "routine")
        self.assertEqual(verdict("PlaceOrder", "mutation PlaceOrder { placeOrder { id } }"), "payment")
        self.assertEqual(verdict("DeleteAddress", "mutation DeleteAddress { deleteAddress { id } }"), "consequential")
        self.assertEqual(verdict("UpdateThing", "mutation UpdateThing { update { id } }"), "unsure",
                         "a field named query is not a search when it carries a mutation")
        self.assertEqual(verdict("", "mutation { x }"), "unsure")

    def test_a_level_lets_through_only_what_it_promises(self):
        cart = {"method": "POST", "host": "shop.example", "path": "/api/cart", "fields": ["item"], "target": "Add to cart"}
        post = {"method": "POST", "host": "x.example", "path": "/comments", "fields": ["body"], "target": "Post"}
        pay = {"method": "POST", "host": "x.example", "path": "/pay", "fields": ["card_token"], "target": "Pay"}
        unsure = {"method": "POST", "host": "x.example", "path": "/step", "fields": ["x"], "target": "Continue"}
        self.assertIsNone(levels.decide_write("ask", cart), "Ask: as before")
        self.assertEqual(levels.decide_write("approve", cart)["what"], "Added to cart on shop.example")
        self.assertIsNone(levels.decide_write("approve", post))
        self.assertIsNone(levels.decide_write("approve", unsure), "unsure asks")
        self.assertIsNotNone(levels.decide_write("full", post))
        self.assertIsNotNone(levels.decide_write("full", unsure))
        for value in levels.LEVELS:
            self.assertIsNone(levels.decide_write(value, pay), f"{value}: a payment asks")
            self.assertIsNone(levels.decide_write(value, {**cart, "payment": True}), f"{value}: a card number asks")


class FloorTests(unittest.TestCase):
    def test_a_command_that_could_wipe_its_files_is_caught_and_ordinary_ones_are_not(self):
        for command in ("rm -rf ~", "rm -rf ~/", "rm -rf ~/*", "rm -rf /home/pip", 'rm -rf "$HOME"', "rm -rf .", "rm -rf ./*",
                        "rm -rf *", "rm -f *", "rm -r -f ~", "rm --recursive --force ~", "rm -rf -- *", "find . -delete",
                        "find ~ -type f -exec rm {} +", 'sh -c "rm -rf ~"', "sudo rm -rf /", "timeout 10 rm -rf ~",
                        "echo $(rm -rf ~)", "ls | xargs rm -rf", ":(){ :|:& };:", "python3 a.py && rm -rf /home/pip/Files",
                        "git clean -fdx", "rsync -a --delete empty/ ~/", "cd ~ && rm -rf *", "shred -u -r ~"):
            with self.subTest(command=command):
                self.assertTrue(levels.floor(command))
        for command in ("rm notes.txt", "rm -rf build/", "rm -rf ~/Downloads/old", "find ~/Downloads -name '*.tmp' -delete",
                        "echo rm -rf ~", 'git commit -m "rm -rf ~"', "ls -la # rm -rf ~", "curl -s https://x.example | head",
                        "find . -name '*.pyc' | xargs rm -f", "git clean -n", "rm 'unclosed", "python3 make_design.py"):
            with self.subTest(command=command):
                self.assertIsNone(levels.floor(command))


class DocumentSiteTests(Store):
    def test_a_site_in_a_document_you_attached_counts_as_named_and_dgcs_own_turns_and_bare_names_do_not(self):
        pip = self.personal(computer=True)
        sent = self.control("send_pip_message", pip_id=pip["id"], text="pay these", idempotency_key="k1",
                            files=[{"name": "lab-invoice.pdf", "data": uri(pdf("Pay online at http://pay.cityscanlabs.pip-test.example:8791 by 28-10"))},
                                   {"name": "notes.docx", "data": uri(docx("Also see www.sunrisehospital.example/pay and bill.pdf, J.Smith"))},
                                   {"name": "todo.txt", "data": uri(b"https://shop.teeforge.example/design\n")}])
        self.store.claim_next()
        self.store.finish(sent["run"]["id"], result={"text": "On it."})
        sites = pip_careful.known(self.registry, pip["id"])
        self.assertTrue({"pip-test.example", "sunrisehospital.example", "teeforge.example"} <= sites, sites)
        self.assertNotIn("bill.pdf", sites)
        self.assertNotIn("j.smith", sites)
        self.assertTrue(self.registry.db.execute("SELECT count(*) FROM metadata WHERE key LIKE 'computer_file_sites:%'").fetchone()[0] == 3,
                        "each file is read once")
        with patch("dgc.documents.extract_text", side_effect=AssertionError("read again")):
            self.assertIn("pip-test.example", pip_careful.known(self.registry, pip["id"]))
        routine = pip_chat.send(self.store, pip["id"], "From your mail", pip_chat.ROUTINE_KEY + "x", "local-routine", self.cfg,
                                _intro=True)
        self.assertTrue(routine["run"]["id"])
        self.assertNotIn("phish.example", pip_careful.file_sites(self.registry, pip["id"]))


class SendTests(unittest.TestCase):
    """Drafts a level sends after the run, as its own actor, re-checked when they run."""
    from tests import test_pip_action_grants as _grants
    setUp = _grants.ActionGrantTests.setUp
    prepare_source = _grants.ActionGrantTests.prepare_source
    propose = _grants.ActionGrantTests.propose
    prepare = _grants.ActionGrantTests.prepare
    sends = _grants.ActionGrantTests.sends
    pip_draft = _grants.ActionGrantTests.pip_draft
    fake_prepared = _grants.ActionGrantTests.fake_prepared

    def dispatch(self):
        from dgc import pip_app_sends as sends
        route = ("composio", self.inspection["connection_digest"], "ca_test", self.inspection["schema_digest"])
        with patch.object(sends, "prepared", self.fake_prepared), patch.object(levels, "_route", return_value=route):
            return levels.dispatch_for_run(self.registry, self.cfg, self.run["id"])

    def test_at_ask_a_draft_waits_and_at_full_access_it_goes_as_the_level(self):
        from dgc import pip_app_actions as actions, pip_message_drafts as drafts
        draft = self.pip_draft()
        self.assertEqual(self.dispatch(), [], "Ask: the draft waits for Send, as before")
        levels.set_level(self.registry, self.source["id"], "full", "editor-user")
        [outcome] = self.dispatch()
        self.assertEqual((outcome["status"], outcome["level"]), ("succeeded", "full"))
        self.assertEqual(len(self.sends()), 1)
        ran = actions.get(self.store, outcome["action_id"])
        self.assertEqual(ran["resolved_by"], "pip-level:full")
        self.assertEqual(drafts.get(self.store, draft["id"])["status"], "prepared")
        [line] = levels.on_its_own(self.registry, self.source["id"])
        self.assertEqual((line["what"], line["kind"], line["level"]), ("Sent an email to review@example.invalid", "app", "full"))

    def test_approve_for_me_sends_only_to_someone_you_named_or_already_wrote_to(self):
        levels.set_level(self.registry, self.source["id"], "approve", "editor-user")
        self.pip_draft({**self.message, "recipient_email": "stranger@example.invalid"})
        self.assertEqual(self.dispatch(), [], "someone new: it asks")
        from dgc import pip_app_actions as actions
        first = self.propose()
        actions.accept(self.store, first["id"], first["digest"], "local-console", self.cfg, prepare=self.prepare)
        self.assertEqual(levels.decide_send(self.registry, self.source["id"], "approve", "email",
                                            {"recipient_email": "review@example.invalid"})["what"],
                         "Sent an email to review@example.invalid", "you already wrote to them from this Pip")
        self.assertIsNone(levels.decide_send(self.registry, self.source["id"], "approve", "email",
                                             {"recipient_email": "stranger@example.invalid"}))
        self.assertIsNone(levels.decide_send(self.registry, self.source["id"], "full", "connector",
                                             {"server": "x", "call": {"tool": "STRIPE_CREATE_CHARGE", "arguments": {}}}),
                          "a payment by its own name asks at Full access too")
        self.assertIsNone(levels.decide_send(self.registry, self.source["id"], "full", "connector",
                                             {"server": "aave", "call": {"tool": "supply", "arguments": {}}}, money=True))
        self.assertIsNotNone(levels.decide_send(self.registry, self.source["id"], "approve", "calendar",
                                                {"summary": "Dentist", "attendees": []}), "your own calendar, no guests")

    def test_a_level_actor_is_checked_again_when_the_action_runs(self):
        from dgc import pip_app_actions as actions
        action = self.propose()
        with self.assertRaises(RegistryError):
            actions.accept(self.store, action["id"], action["digest"], "pip-level:full", self.cfg, prepare=self.prepare)
        self.assertEqual(self.sends(), [], "at Ask, a level actor can't send anything")
        with self.assertRaises(RegistryError):
            actions._acting("pip-level:sudo")


class RecordTests(Store):
    def insert(self, pip, summary, status="sent", resolved_by="pip-level:approve", at="2026-10-21T01:00:00.000Z"):
        action_id = "compact_" + hashlib.sha256(json.dumps(summary).encode() + at.encode()).hexdigest()[:32]
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO pip_computer_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
                                     (action_id, pip["id"], pip["workspace_id"], None, "host_x", "level:x", json.dumps(summary),
                                      pip_computer._digest(summary), None, status, at, "2099-01-01T00:00:00.000Z",
                                      at if status != "pending" else None, resolved_by if status != "pending" else None))
        return action_id

    def test_what_it_did_on_its_own_is_listed_newest_first_once_each_and_never_hides_a_card(self):
        pip = self.personal(computer=True)
        base = {"method": "POST", "host": "shop.example", "path": "/cart", "fields": [], "more_fields": 0, "body_bytes": 0, "page": ""}
        waiting = self.insert(pip, {**base, "path": "/order"}, status="pending", at="2026-10-21T00:59:00.000Z")
        for i in range(6):
            self.insert(pip, {**base, "what": "Added to cart on shop.example", "level": "approve", "unattended": False},
                        at=f"2026-10-21T01:0{i}:00.000Z")
        self.insert(pip, {**base, "what": "Opened shop.example for the first time", "kind": "site", "level": "full",
                          "unattended": True}, resolved_by="pip-level:full", at="2026-10-21T01:09:00.000Z")
        listed = levels.on_its_own(self.registry, pip["id"])
        self.assertEqual([(l["what"], l["unattended"], l["level"], l["kind"]) for l in listed],
                         [("Opened shop.example for the first time", True, "full", "site"),
                          ("Added to cart on shop.example", False, "approve", "computer")])
        status = pip_computer.status(self.registry, pip["id"])
        self.assertEqual(status["actions"][0]["id"], waiting, "what waits for you comes first")
        self.assertLessEqual(len(status["actions"]), 5)


class _FakeBrowser:
    """The browser's side of a held request, for the gate every step shares (browser steps, steps by position, the
    whole desktop and a subscription brain's calls all end in Host._record_held)."""

    def __init__(self):
        self.held, self.released, self.current_url = {}, [], "https://shop.example/tee"

    def hold(self, request_id, **kw):
        held = box.HeldWrite(request_id, "s", kw.get("method", "POST"), kw.get("url", "https://shop.example/api/cart"),
                             kw.get("fields", [("item", "tee")]), 10, time.time(), payment=kw.get("payment", False),
                             site=kw.get("site", False))
        self.held[request_id] = held
        return held

    def release(self, request_id):
        self.released.append(request_id)
        self.held.pop(request_id)

    def pump(self, seconds):
        pass

    def form_cues(self, url):
        return {"buttons": ["Add to cart"]}

    def screenshot_jpeg(self, *a):
        return b"\xff\xd8\xff\xd9"

    def evaluate_json(self, *a):
        raise box.BrowserError("no page")


class SharedGateTests(Store):
    def host(self, level, unattended=False):
        pip = self.personal(computer=True)
        queued = self.store.enqueue(pip["id"], "gate-" + str(time.monotonic_ns()), "local-console", self.cfg)
        self.store.claim_next()
        host = pip_computer.Host.__new__(pip_computer.Host)
        host.state_directory, host.pip_id, host.workspace_id, host.id = self.registry.directory, pip["id"], pip["workspace_id"], "host_t"
        host.browser, host._queued, host.waiting, host.sites, host.frames = _FakeBrowser(), [], [], set(), 0
        host.frames_dir = self.registry.directory / "frames"
        host.frames_dir.mkdir()
        host.run_id, host.level, host.unattended, host.target, host.upload_from_chat = queued["id"], level, unattended, "", None
        host._level_pending, host.lock = [], threading.RLock()
        return pip, host

    def test_the_shared_gate_sends_what_its_level_allows_and_keeps_the_rest_waiting(self):
        pip, host = self.host("approve", unattended=True)
        host._queued.append(host.browser.hold("r1"))
        host._queued.append(host.browser.hold("r2", url="https://shop.example/pay", fields=[("cardnumber", "•••")], payment=True))
        host._queued.append(host.browser.hold("r3", site=True, method="GET", url="https://new.example/", fields=[]))
        made = host._record_held()
        self.assertEqual(host.browser.released, ["r1", "r3"], "the cart and the new site's first visit went; the payment waits")
        self.assertEqual(len(made), 1)
        self.assertIn("new.example", host.sites)
        approved = pip_computer.Host._level_take(host)
        self.assertEqual([words for _, words, _ in approved],
                         ["Approved by its level: Approve for me · Added to cart on shop.example · nobody at the keyboard",
                          "Approved by its level: Approve for me · Opened new.example for the first time · nobody at the keyboard"])
        rows = {r["status"]: r for r in pip_computer.list_actions(self.registry, pip["id"])}
        self.assertEqual(rows["sent"]["resolved_by"], "pip-level:approve")
        self.assertTrue(rows["pending"]["summary"]["payment"])

    def test_at_ask_the_shared_gate_is_as_before(self):
        pip, host = self.host("ask")
        host._queued.append(host.browser.hold("r1"))
        self.assertEqual(len(host._record_held()), 1)
        self.assertEqual(host.browser.released, [])


def _shop_server():
    received = []
    page = (b'<!doctype html><title>Tee shop</title><h1>Tee shop</h1>'
            b'<form method="post" action="/cart/add"><input name="item" value="tee-black"><input name="qty" value="20">'
            b'<button type="submit">Add to cart</button></form>'
            b'<form method="post" action="/order"><input name="email" value="ada@example.com"><button type="submit">Place order</button></form>'
            b'<form method="post" action="/comments"><input name="body" value="Lovely shirts"><button type="submit">Post comment</button></form>'
            b'<form method="post" action="/pay"><input name="cardnumber" value="4242 4242 4242 4242"><button type="submit">Pay 500</button></form>'
            b'<form method="post" action="/pay-saved"><input type="hidden" name="card_token" value="tok_123"><button type="submit">Use saved card</button></form>'
            b'<form method="post" action="/step"><input name="x" value="1"><button type="submit">Continue</button></form>')

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, body):
            self.send_response(200); self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        def do_GET(self):
            self._send(page)

        def do_POST(self):
            received.append((self.path, self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()))
            self._send(b"<!doctype html><title>Done</title><p>Done.</p>")

    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True
    server = Server(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, received


@unittest.skipUnless(REAL_CHROME and box.capability().get("available"), "needs Linux, bubblewrap and a Chromium build")
class RealBrowserTests(Store):
    def setUp(self):
        Store.setUp(self)
        self.server, self.received = _shop_server()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        port = self.server.server_address[1]
        self.url = f"http://{TEST_HOST}:{port}/"
        policy = lambda host, p, **kw: ["127.0.0.1"] if host == TEST_HOST and p == port else []
        for target, value in (("public_addresses", policy), ("find_chrome", lambda home=None: REAL_CHROME)):
            p = patch.object(box, target, value)
            p.start(); self.addCleanup(p.stop)
        p = patch.object(box, "capability", lambda home=None: {"available": True, "reason": "", "chrome": str(REAL_CHROME)})
        p.start(); self.addCleanup(p.stop)
        self.addCleanup(pip_computer.stop_all)
        self.cfg.data["pips_enabled"] = True

    def host(self, level, *, sites=(TEST_HOST,), unattended=False):
        pip = self.personal(computer=True)
        for site in sites:
            pip_careful.add_site(self.registry, pip["id"], site, "you")
        queued = self.store.enqueue(pip["id"], "levels-" + str(time.monotonic_ns()), "local-console", self.cfg)
        self.store.claim_next()
        host = pip_computer.host_for(self.registry.directory, pip["id"], pip["workspace_id"])
        host.begin(queued["id"], self.registry.directory / "runs" / queued["id"] / "artifacts" / "computer", careful=True,
                   sites=pip_careful.known(self.registry, pip["id"]), level=level, unattended=unattended)
        self.addCleanup(host.end)
        return pip, host, queued

    def press(self, host, name):
        page = host.call("read", {})
        ref = re.search(r'button "' + re.escape(name) + r'" \[(e\d+)\]', page).group(1)
        return host.call("click", {"ref": ref})

    def reset(self, host):
        host.waiting = []
        host.call("open", {"url": self.url})

    def test_at_ask_the_cart_still_waits_for_you_and_a_hold_answers_at_once(self):
        pip, host, _ = self.host("ask")
        host.call("open", {"url": self.url})
        started = time.monotonic()
        self.assertTrue(self.press(host, "Add to cart").startswith("Held:"))
        # A page whose form submit is held answers no script: each picture of it waited 30 s for the page's address.
        self.assertLess(time.monotonic() - started, 20, "a held submit's pictures no longer wait a minute")
        self.assertEqual(self.received, [])
        started = time.monotonic()
        host.end()
        self.assertLess(time.monotonic() - started, 15, "nor does the run's end")

    def test_approve_for_me_opens_a_new_site_and_adds_to_the_cart_but_asks_before_the_order(self):
        pip, host, queued = self.host("approve", sites=())
        opened = host.call("open", {"url": self.url})
        self.assertIn("Tee shop", opened, "a new site's first visit is routine: no card")
        said = self.press(host, "Add to cart")
        self.assertIn("DGC approved that by the user's level (Approve for me): Added to cart on " + TEST_HOST, said)
        self.assertEqual([p for p, _ in self.received], ["/cart/add"])
        self.reset(host)
        self.assertTrue(self.press(host, "Place order").startswith("Held:"), "an order asks")
        self.assertEqual([p for p, _ in self.received], ["/cart/add"])
        rows = pip_computer.list_actions(self.registry, pip["id"])
        sent = [r for r in rows if r["status"] == "sent"]
        self.assertEqual(sorted(r["summary"]["what"] for r in sent),
                         [f"Added to cart on {TEST_HOST}", f"Opened {TEST_HOST} for the first time"])
        self.assertTrue(all(r["resolved_by"] == "pip-level:approve" and r["frame"] for r in sent), "each with its picture")
        labels = [f["label"] for f in pip_computer.frames(self.registry.directory, queued["id"])]
        self.assertTrue(any(f"Approved by its level: Approve for me · Added to cart on {TEST_HOST}" in l for l in labels), labels)
        self.assertNotIn(TEST_HOST, {s["site"] for s in pip_careful.listing(self.registry, pip["id"])["sites"]},
                         "the level opened it; your allowed sites are still yours")
        got = levels.listing(self.registry, pip["id"])
        self.assertEqual(got["on_its_own"][0]["what"], f"Added to cart on {TEST_HOST}")

    def test_full_access_asks_only_for_payments_and_notes_nobody_at_the_keyboard(self):
        pip, host, queued = self.host("full", unattended=True)
        host.call("open", {"url": self.url})
        self.assertIn("Full access", self.press(host, "Post comment"))
        self.reset(host)
        self.assertNotIn("Held", self.press(host, "Continue"), "not sure what it is: Full access lets it through")
        self.assertEqual([p for p, _ in self.received], ["/comments", "/step"])
        for name in ("Pay 500", "Use saved card", "Place order"):
            self.reset(host)
            with self.subTest(name=name):
                self.assertTrue(self.press(host, name).startswith("Held:"), f"{name} is a payment: it asks at Full access")
        self.assertEqual([p for p, _ in self.received], ["/comments", "/step"])
        held = {a["summary"]["path"]: a["summary"] for a in pip_computer.list_actions(self.registry, pip["id"]) if a["status"] == "pending"}
        self.assertTrue(held["/pay"]["payment"], "a card number: its card says it sends card details")
        self.assertEqual((held["/pay-saved"].get("payment"), held["/pay-saved"]["asks_because"]), (None, "payment"),
                         "a saved card sends a token: its card says it looks like a payment")
        labels = [f["label"] for f in pip_computer.frames(self.registry.directory, queued["id"])]
        self.assertTrue(any("Approved by its level: Full access" in l and "nobody at the keyboard" in l for l in labels), labels)

    def test_the_floor_holds_a_wipe_at_every_level_and_allow_lets_that_command_run_once(self):
        from dgc import pip_computer_files as desk
        pip, host, _ = self.host("full")
        files = desk.files_root(host.root)
        (files / "keep.txt").write_text("mine")
        said = host.call("run", {"command": "rm -rf ~/*"})
        self.assertTrue(said.startswith("Held: that command could delete everything in your Files, so DGC asks the user first"), said)
        self.assertTrue((files / "keep.txt").exists())
        [action] = [a for a in pip_computer.list_actions(self.registry, pip["id"]) if a["status"] == "pending"]
        self.assertEqual(action["summary"]["kind"], "floor")
        with self.assertRaises(RegistryError):
            pip_computer.approve_always(self.registry, action["id"], action["digest"], "editor-user")
        host.waiting = []
        self.assertIn("exit 0", host.call("run", {"command": "ls"}), "an ordinary command just runs")
        pip_computer.decide(self.registry, action["id"], action["digest"], True, "editor-user")
        pip_computer.tick(self.registry, self.cfg)
        self.assertIn("exit 0", host.call("run", {"command": "rm -rf ~/*"}))
        self.assertFalse((files / "keep.txt").exists(), "allowed once, it ran")
        host.waiting = []
        self.assertTrue(host.call("run", {"command": "rm -rf ~/*"}).startswith("Held:"), "once means once")


if __name__ == "__main__":
    unittest.main()
