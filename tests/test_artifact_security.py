"""The artifact server publishes only what a page needs, only to this machine's own addresses.

Each exposure closed in 0.39 has a test that fails on the old server: a DNS-rebinding Host, dot-files
and dot-directories at any depth, symlinks out of the artifact folder, a workspace-root artifact
serving the whole project, a cross-origin POST /_stop, counter ids, a missing CSP, and the artifact
tool ignoring deny rules. Compatibility tests keep a multi-file site in a subfolder, LAN mode, a
configured hostname, the shell page and plan pages working. Servers bind ports 5031-5040 only."""
from __future__ import annotations

import http.client
import json
import os
import re
import socket
import sys
import tempfile
import time
import unittest
from pathlib import Path

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    # Run standalone: never read or rewrite the developer's real ~/.dgc registry.
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

import dgc.artifacts as A  # noqa: E402

MAIN_PORT, PLAN_PORT, LAN_PORT, AGENT_PORT, REVIEW_PORT = 5031, 5033, 5035, 5037, 5039
ENV_SECRET = b"sk-artifact-test-secret"


def _write(path: Path, text) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text, encoding="utf-8")
    return path


def request(port, method, path, host="default", headers=None, body=None, address="127.0.0.1"):
    conn = http.client.HTTPConnection(address, port, timeout=5)
    try:
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        if host == "default":
            host = f"127.0.0.1:{port}"
        if host is not None:
            conn.putheader("Host", host)
        for key, value in (headers or {}).items():
            conn.putheader(key, value)
        payload = body if body is not None else (b"" if method == "POST" else None)
        if payload is not None:
            conn.putheader("Content-Length", str(len(payload)))
        conn.endheaders(payload)
        resp = conn.getresponse()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
    finally:
        conn.close()


class ArtifactServerSecurity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="dgc-artsec-")
        tmp = Path(os.path.realpath(cls._tmp.name))
        cls._saved_state = A.STATE_FILE
        A.STATE_FILE = tmp / "artifacts.json"
        proj = cls.proj = tmp / "proj"
        _write(proj / ".git" / "config", '[remote "origin"]\n\turl = https://ghp_token@github.com/x/y\n')
        _write(proj / ".env", b"OPENAI_API_KEY=" + ENV_SECRET + b"\n")
        _write(proj / ".dgc" / "notes.json", '{"private": "dgc state"}')
        _write(proj / "docs" / "plan.pdf", b"%PDF-1.4 unreleased roadmap")
        _write(proj / "src" / "server.py", "SECRET_SOURCE = 1\n")
        _write(proj / "package.json", '{"name": "proj"}')
        _write(proj / "vite.config.js", "export default {}")
        _write(proj / "notlinked.html", "<p>not linked</p>")
        # A single-page artifact written at the project root, with the assets it links to.
        _write(proj / "index.html", '<link rel="stylesheet" href="style.css"><script src="app.js"></script>'
                                    '<img srcset="img/a.png 1x, img/b.png 2x"><h1>root page</h1>')
        _write(proj / "style.css", "body{background:url('img/bg.png')}")
        _write(proj / "app.js", "fetch('data/points.json').then(r => r.json())")
        _write(proj / "img" / "bg.png", b"\x89PNG bg")
        _write(proj / "img" / "a.png", b"\x89PNG a")
        _write(proj / "img" / "b.png", b"\x89PNG b")
        _write(proj / "data" / "points.json", "[1, 2, 3]")
        # A real multi-file site in its own folder.
        site = cls.site = proj / "site"
        _write(site / "index.html", '<link rel="stylesheet" href="css/app.css">'
                                    '<script type="module" src="js/app.js"></script>'
                                    '<img src="img/logo.svg"><a href="about.html">about</a>')
        _write(site / "about.html", "<h1>about</h1>")
        _write(site / "css" / "app.css", "h1{color:#7C5CFF}")
        _write(site / "js" / "app.js", "import { n } from './util.mjs'; console.log(n)")
        _write(site / "js" / "util.mjs", "export const n = 1")
        _write(site / "img" / "logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>")
        _write(site / "data.json", '{"unlinked": true}')
        _write(site / ".secret", "site dot file")
        _write(site / "sub" / ".git" / "config", "nested git")
        _write(site / "deploy.key", "-----BEGIN PRIVATE KEY-----")
        _write(site / "api.py", "SERVER_SOURCE = 1")
        cls.symlinks = True
        try:
            os.symlink(proj / ".env", site / "escape.css")
            os.symlink(proj / "src", site / "outside")
            os.symlink(site / ".secret", site / "innocent.css")
        except (OSError, NotImplementedError):
            cls.symlinks = False
        cls.srv = A._Server(persistent=False)
        cls.root_art = cls.srv.add("index.html", proj, "root page", preferred_port=MAIN_PORT)
        cls.site_art = cls.srv.add("site", proj, "site", preferred_port=MAIN_PORT)
        cls.port = cls.srv.port
        cls.plan = A.serve_plan("# Plan\n\n1. inspect `<tag>`", proj, "Plan", preferred_port=PLAN_PORT)
        cls.plan_port = A._PLAN_SRV.port

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        A.stop(cls.plan.id)
        A._PLAN_SRV.shutdown()
        A.STATE_FILE = cls._saved_state
        cls._tmp.cleanup()

    def get(self, path, **kw):
        return request(self.port, "GET", path, **kw)

    # ---- exposures ----------------------------------------------------------------------------
    def test_rebinding_host_is_refused_on_every_route(self):
        evil = f"evil.example.com:{self.port}"
        for method, path in (("GET", "/"), ("GET", "/_list"), ("GET", f"/a/{self.root_art.id}/.env"),
                             ("GET", f"/a/{self.site_art.id}/"), ("HEAD", f"/a/{self.site_art.id}/"),
                             ("POST", f"/_stop/{self.site_art.id}")):
            status, _, body = request(self.port, method, path, host=evil)
            self.assertEqual(status, 421, f"{method} {path}")
            self.assertNotIn(ENV_SECRET, body)
        for host in (None, "evil.example.com", "127.0.0.1.evil.example.com", "localhost.evil.example",
                     "127.0.0.1@evil.example.com", "localhost:abc"):
            self.assertEqual(self.get(f"/a/{self.site_art.id}/", host=host)[0], 421, host)
        self.assertIn(self.site_art.id, self.srv.artifacts)
        status, _, _ = request(self.plan_port, "GET", f"/a/{self.plan.id}/",
                               host=f"evil.example.com:{self.plan_port}")
        self.assertEqual(status, 421, "plan pages share the Host allowlist")

    def test_loopback_hosts_are_served_on_any_forwarded_port(self):
        for host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}", f"[::1]:{self.port}",
                     "localhost", "LOCALHOST:9000", "127.0.0.1:64000"):
            status, _, body = self.get(f"/a/{self.site_art.id}/", host=host)
            self.assertEqual(status, 200, host)
            self.assertIn(b"css/app.css", body)

    def test_dot_files_and_dot_directories_are_never_served(self):
        for art, rel in ((self.root_art, ".env"), (self.root_art, ".git/config"),
                         (self.root_art, ".dgc/notes.json"), (self.root_art, "%2eenv"),
                         (self.root_art, "img/../.env"), (self.site_art, ".secret"),
                         (self.site_art, "sub/.git/config"), (self.site_art, "sub/%2Egit/config"),
                         (self.site_art, "deploy.key"), (self.site_art, "..%2f.env")):
            status, _, body = self.get(f"/a/{art.id}/{rel}")
            self.assertNotEqual(status, 200, rel)
            self.assertNotIn(ENV_SECRET, body)
            self.assertNotIn(b"nested git", body)
            self.assertNotIn(b"ghp_token", body)

    def test_symlinks_leaving_the_folder_or_landing_on_private_files_are_refused(self):
        if not self.symlinks:
            self.skipTest("symlinks unavailable")
        for rel in ("escape.css", "outside/server.py", "innocent.css"):
            status, _, body = self.get(f"/a/{self.site_art.id}/{rel}")
            self.assertNotEqual(status, 200, rel)
            self.assertNotIn(ENV_SECRET, body)
            self.assertNotIn(b"SECRET_SOURCE", body)

    def test_workspace_root_artifact_serves_only_its_page_and_linked_assets(self):
        self.assertTrue(self.root_art.scoped)
        aid = self.root_art.id
        for rel, expect in (("", b"root page"), ("index.html", b"root page"), ("style.css", b"img/bg.png"),
                            ("app.js", b"points.json"), ("img/bg.png", b"PNG bg"), ("img/a.png", b"PNG a"),
                            ("img/b.png", b"PNG b"), ("data/points.json", b"[1, 2, 3]")):
            status, _, body = self.get(f"/a/{aid}/{rel}")
            self.assertEqual(status, 200, rel)
            self.assertIn(expect, body)
        for rel in ("src/server.py", "package.json", "vite.config.js", "docs/plan.pdf", "notlinked.html",
                    "site/index.html", "src/", "docs/"):
            status, _, body = self.get(f"/a/{aid}/{rel}")
            self.assertEqual(status, 404, rel)
            self.assertNotIn(b"SECRET_SOURCE", body)
            self.assertNotIn(b"roadmap", body)

    def test_artifact_tool_refuses_private_paths_and_non_pages(self):
        srv = A._Server(persistent=False)
        try:
            for path in (".env", ".git", ".git/config", ".dgc", "src/server.py", "src", "package.json"):
                with self.assertRaises(Exception, msg=path):
                    srv.add(path, self.proj, preferred_port=MAIN_PORT)
            self.assertEqual(srv.artifacts, {})
        finally:
            srv.shutdown()

    def test_dedicated_folder_serves_its_assets_but_not_source_or_keys(self):
        self.assertFalse(self.site_art.scoped)
        self.assertEqual(self.get(f"/a/{self.site_art.id}/data.json")[0], 200)
        for rel in ("api.py", "deploy.key"):
            status, _, body = self.get(f"/a/{self.site_art.id}/{rel}")
            self.assertEqual(status, 404, rel)
            self.assertNotIn(b"SERVER_SOURCE", body)

    def test_cross_origin_or_tokenless_stop_is_refused(self):
        victim = self.srv.add("site", self.proj, "victim", preferred_port=MAIN_PORT)
        path = f"/_stop/{victim.id}"
        token = self.srv.__dict__.get("token", "")
        for headers in ({"Origin": "http://evil.example.com"}, {},
                        {"Origin": "null"},
                        {"X-DGC-Artifact-Token": "guess"},
                        {"X-DGC-Artifact-Token": token, "Origin": "http://evil.example.com"},
                        {"X-DGC-Artifact-Token": token, "Sec-Fetch-Site": "cross-site"}):
            status, _, _ = request(self.port, "POST", path, headers=headers)
            self.assertEqual(status, 403, headers)
            self.assertIn(victim.id, self.srv.artifacts)
        self.srv.remove(victim.id)

    def test_the_shell_stop_button_still_works_with_its_token(self):
        doomed = self.srv.add("site", self.proj, "doomed", preferred_port=MAIN_PORT)
        _, _, shell = self.get("/")
        match = re.search(rb'const TOKEN = "([^"]+)"', shell)
        self.assertIsNotNone(match)
        self.assertIn(b"X-DGC-Artifact-Token", shell)
        status, _, body = request(self.port, "POST", f"/_stop/{doomed.id}", headers={
            "X-DGC-Artifact-Token": match.group(1).decode(), "Origin": f"http://127.0.0.1:{self.port}",
            "Sec-Fetch-Site": "same-origin"})
        self.assertEqual((status, json.loads(body)), (200, {"ok": True}))
        self.assertNotIn(doomed.id, self.srv.artifacts)

    def test_artifact_ids_are_unguessable(self):
        ids = [self.root_art.id, self.site_art.id]
        for aid in ids:
            self.assertRegex(aid, r"^a[0-9a-f]{16}$")
        self.assertRegex(self.plan.id, r"^p[0-9a-f]{16}$")
        self.assertNotEqual(*ids)

    def test_legacy_registry_is_rekeyed_scoped_and_drops_private_entries(self):
        state = Path(self._tmp.name) / "legacy.json"
        state.write_text(json.dumps({"port": MAIN_PORT, "counter": 3, "artifacts": [
            {"id": "a1", "name": "root", "directory": str(self.proj), "entry": "index.html"},
            {"id": "a2", "name": "env", "directory": str(self.proj), "entry": ".env"},
            {"id": "a3", "name": "site", "directory": str(self.site), "entry": ""}]}))
        saved, A.STATE_FILE = A.STATE_FILE, state
        try:
            loaded = A._Server()
        finally:
            A.STATE_FILE = saved
        names = {a.name: a for a in loaded.artifacts.values()}
        self.assertEqual(set(names), {"root", "site"})
        self.assertTrue(all(re.fullmatch(r"a[0-9a-f]{16}", aid) for aid in loaded.artifacts))
        self.assertTrue(names["root"].scoped and names["site"].scoped)
        target, status, _ = A.resolve_request(names["root"], "src/server.py")
        self.assertEqual((target, status), (None, 404))
        persisted = json.loads(state.read_text())
        self.assertNotIn("a1", [a["id"] for a in persisted["artifacts"]])

    def test_security_headers_and_nonce_csp_on_the_shell(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(headers.get("referrer-policy"), "no-referrer")
        csp = headers.get("content-security-policy", "")
        nonce = re.search(r"script-src 'nonce-([^']+)'", csp)
        self.assertIsNotNone(nonce, csp)
        self.assertNotIn("unsafe-inline", csp)
        self.assertIn("default-src 'none'", csp)
        self.assertIn("frame-ancestors 'self'", csp)
        self.assertIn(f'<script nonce="{nonce.group(1)}">'.encode(), body)
        self.assertIn(f'<style nonce="{nonce.group(1)}">'.encode(), body)
        second = self.get("/")[1].get("content-security-policy", "")
        self.assertNotEqual(csp, second, "the nonce is fresh per response")
        _, file_headers, _ = self.get(f"/a/{self.site_art.id}/css/app.css")
        self.assertEqual(file_headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(file_headers.get("referrer-policy"), "no-referrer")
        self.assertIn("frame-ancestors 'self'", file_headers.get("content-security-policy", ""))

    def test_the_shell_and_plan_pages_declare_an_icon_and_no_favicon_request_404s(self):
        # Before: neither page declared an icon, so the browser fetched /favicon.ico and logged a 404
        # on every open of the shell (and of an artifact page opened on its own).
        _, headers, body = self.get("/")
        icon = re.search(rb'<link rel="icon" href="(data:image/svg\+xml,[^"]+)"', body)
        self.assertIsNotNone(icon, "the shell declares an inline icon")
        self.assertIn("img-src 'self' data:", headers.get("content-security-policy", ""),
                      "the shell's CSP allows the data: icon it declares")
        _, plan_headers, plan = request(self.plan_port, "GET", f"/a/{self.plan.id}/")
        self.assertRegex(plan, rb'<link rel="icon" href="data:image/svg\+xml,')
        self.assertIn("img-src data:", plan_headers.get("content-security-policy", ""))
        for port in (self.port, self.plan_port):
            status, favicon_headers, favicon = request(port, "GET", "/favicon.ico")
            self.assertEqual(status, 200, port)
            self.assertEqual(favicon_headers.get("content-type"), "image/svg+xml")
            self.assertTrue(favicon.startswith(b"<svg"), favicon[:40])
        self.assertEqual(request(self.port, "GET", "/favicon.ico", host="evil.example.com")[0], 421)

    def test_plan_pages_forbid_scripts_and_loads(self):
        status, headers, body = request(self.plan_port, "GET", f"/a/{self.plan.id}/")
        self.assertEqual(status, 200)
        self.assertIn(b"&lt;tag&gt;", body)
        csp = headers.get("content-security-policy", "")
        self.assertIn("default-src 'none'", csp)
        self.assertNotIn("script-src", csp)
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")

    def test_no_directory_listing(self):
        for rel in ("img/", "css", "js/"):
            status, _, body = self.get(f"/a/{self.site_art.id}/{rel}")
            self.assertEqual(status, 404, rel)
            self.assertNotIn(b"logo.svg", body)
            self.assertNotIn(b"app.css", body)

    def test_deny_rule_blocks_the_artifact_tool(self):
        from dgc.agent import Agent
        from dgc.config import Config
        from dgc.llm import ToolCall

        class UI:
            def __getattr__(self, name):
                return lambda *a, **k: None

        config = Config(self.proj)
        config.data["artifact_port"] = AGENT_PORT
        config.permissions["deny"] = ["Artifact"]
        agent = Agent(config, UI())
        before = {a.id for a in A.registry()}
        out = agent._handle_call(ToolCall("art-1", "artifact", {"path": "site", "name": "denied"}))
        self.assertIn("PERMISSION DENIED", out)
        self.assertEqual({a.id for a in A.registry()}, before)

    # ---- compatibility ------------------------------------------------------------------------
    def test_multi_file_site_in_a_subfolder_works(self):
        aid = self.site_art.id
        for rel, ctype, expect in (("", "text/html", b"js/app.js"), ("about.html", "text/html", b"about"),
                                   ("css/app.css", "text/css", b"7C5CFF"),
                                   ("js/app.js", "javascript", b"util.mjs"),
                                   ("js/util.mjs", "javascript", b"export"),
                                   ("img/logo.svg", "image/svg", b"<svg")):
            status, headers, body = self.get(f"/a/{aid}/{rel}")
            self.assertEqual(status, 200, rel)
            self.assertIn(ctype, headers.get("content-type", ""), rel)
            self.assertIn(expect, body)

    def test_shell_page_lists_and_frames_every_artifact(self):
        status, _, body = self.get(f"/?a={self.site_art.id}")
        self.assertEqual(status, 200)
        self.assertIn(b"<select", body)
        self.assertIn(f'src="/a/{self.site_art.id}/"'.encode(), body)
        self.assertIn(self.root_art.id.encode(), body)
        _, _, retired = self.get("/?a=a1")                   # an id retired on upgrade frames the newest
        newest = self.srv.list()[0]
        self.assertIn(f'src="{newest.path}"'.encode(), retired)
        status, _, listing = self.get("/_list")
        ids = {item["id"] for item in json.loads(listing)["artifacts"]}
        self.assertEqual(status, 200)
        self.assertLessEqual({self.root_art.id, self.site_art.id}, ids)

    def test_lan_mode_answers_this_machines_addresses_only(self):
        lan = A._Server(persistent=False)
        try:
            art = lan.add("site", self.proj, "lan site", preferred_port=LAN_PORT, lan=True)
            port = lan.port
            hosts = [f"{lan.host}:{port}", f"localhost:{port}"]
            name = socket.gethostname().strip().lower()
            if name:
                hosts += [f"{name}:{port}", f"{name.split('.')[0]}.local:{port}"]
            for host in hosts:
                self.assertEqual(request(port, "GET", f"/a/{art.id}/", host=host)[0], 200, host)
            self.assertEqual(request(port, "GET", f"/a/{art.id}/", host=f"evil.example.com:{port}")[0], 421)
            self.assertNotEqual(request(port, "GET", f"/a/{art.id}/.secret")[0], 200)
            if lan.host != "127.0.0.1":                      # a real request over the LAN interface
                status, _, body = request(port, "GET", f"/a/{art.id}/css/app.css",
                                          host=f"{lan.host}:{port}", address=lan.host)
                self.assertEqual(status, 200)
                self.assertIn(b"7C5CFF", body)
        finally:
            lan.shutdown()

    def test_configured_hostname_is_accepted(self):
        srv = A._Server(persistent=False)
        try:
            art = srv.add("site", self.proj, "proxied", preferred_port=MAIN_PORT,
                          hostname="https://dgc-box.tailnet.ts.net/")
            port = srv.port
            ok = request(port, "GET", f"/a/{art.id}/", host="dgc-box.tailnet.ts.net")
            self.assertEqual(ok[0], 200)
            self.assertEqual(request(port, "GET", f"/a/{art.id}/", host="other.tailnet.ts.net")[0], 421)
        finally:
            srv.shutdown()


class ArtifactScopeEdges(unittest.TestCase):
    """Nested projects, dot folders, document-relative script names, server-side files in a dedicated
    folder, prose mentions, quoted entry names, stalled connections, and the link cache."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="dgc-artscope-")
        tmp = Path(os.path.realpath(cls._tmp.name))
        cls._saved_state = A.STATE_FILE
        A.STATE_FILE = tmp / "artifacts.json"
        proj = cls.proj = tmp / "proj"
        _write(proj / ".git" / "HEAD", "ref: refs/heads/main\n")
        # A page in a folder without markers that holds a whole project one level down.
        pk = proj / "packages"
        _write(pk / "index.html", '<link rel="stylesheet" href="css/site.css"><img src="api/logo.png">')
        _write(pk / "css" / "site.css", "h1{color:#7C5CFF}")
        _write(pk / "notes.txt", "public notes")
        _write(pk / "api_keys.json", '{"key": "SECRET"}')
        _write(pk / "api" / "package.json", '{"name": "api"}')
        _write(pk / "api" / "logo.png", b"\x89PNG logo")
        _write(pk / "api" / "config" / "secrets.yaml", "db_password: SECRET")
        _write(pk / "api" / "firebase-adminsdk.json", '{"private_key": "SECRET"}')
        _write(pk / "api" / "client_secret.json", '{"client_secret": "SECRET"}')
        _write(pk / "api" / "index.ts", "const KEY = 'SECRET'")
        _write(pk / "api" / "public.css", "unlinked but a web file")
        # A page at the project root whose script names files relative to the page.
        _write(proj / "index.html",
               '<script src="js/app.js"></script><img data-src="img/lazy.png">'
               "<p>Setup: save your key as 'google-services.json' and 'notes.json'</p>"
               "<script>fetch('token.json'); const f = ['appsettings.json', 'local.settings.json', "
               "'firebase-adminsdk-abc.json', 'keyfile.json', 'env.js', 'auth.json']</script>")
        _write(proj / "js" / "app.js", "fetch('data/sales.json'); new Worker('js/worker.js'); "
                                       "import('./chart.mjs')")
        _write(proj / "js" / "worker.js", "fetch('rows.json')")
        _write(proj / "js" / "chart.mjs", "export default 1")
        _write(proj / "js" / "rows.json", "[4]")
        _write(proj / "data" / "sales.json", '[{"region": "north", "total": 3}]')
        _write(proj / "img" / "lazy.png", b"\x89PNG lazy")
        for name in ("google-services.json", "notes.json", "token.json", "appsettings.json",
                     "local.settings.json", "firebase-adminsdk-abc.json", "keyfile.json", "env.js",
                     "auth.json"):
            _write(proj / name, '{"secret": "SECRET"}')
        # A dedicated in-browser app that loads Python, a database and JSX, next to unlinked data.
        app = cls.app = proj / "artifacts" / "pyapp"
        _write(app / "index.html", '<script type="py" src="main.py" config="pyscript.toml"></script>'
                                   '<script type="text/babel" src="app.jsx"></script>'
                                   "<script>fetch('db/app.sqlite')</script>")
        _write(app / "main.py", "print('hello from pyscript')")
        _write(app / "pyscript.toml", 'packages = ["numpy"]')
        _write(app / "app.jsx", "const App = () => <h1/>")
        _write(app / "db" / "app.sqlite", b"SQLite format 3 linked")
        for name, body in (("db.sqlite-wal", "WAL SECRET"), ("config.yaml", "password: SECRET"),
                           ("app.ts", "const KEY='SECRET'"), ("terraform.tfstate.backup", "SECRET"),
                           ("site.bak", "SECRET"), ("data.db-journal", "SECRET"), ("vpn.ovpn", "SECRET"),
                           ("server.py", "SECRET")):
            _write(app / name, body)
        cls.srv = A._Server(persistent=False)
        cls.nested = cls.srv.add("packages/index.html", proj, "nested", preferred_port=REVIEW_PORT)
        cls.root = cls.srv.add("index.html", proj, "root", preferred_port=REVIEW_PORT)
        cls.pyapp = cls.srv.add("artifacts/pyapp", proj, "pyapp", preferred_port=REVIEW_PORT)
        cls.port = cls.srv.port

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        A.STATE_FILE = cls._saved_state
        cls._tmp.cleanup()

    def status(self, art, rel, **kw):
        status, _, body = request(self.port, "GET", f"/a/{art.id}/{rel}", **kw)
        if status == 200:
            self.assertNotIn(b"SECRET", body, rel)
        return status

    def test_a_project_nested_in_a_dedicated_folder_is_scoped(self):
        self.assertFalse(self.nested.scoped)
        for rel in ("api/config/secrets.yaml", "api/firebase-adminsdk.json", "api/client_secret.json",
                    "api/index.ts", "api/package.json", "api/public.css", "api_keys.json"):
            self.assertEqual(self.status(self.nested, rel), 404, rel)
        for rel in ("", "css/site.css", "notes.txt", "api/logo.png"):
            self.assertEqual(self.status(self.nested, rel), 200, rel)
        lan = A._Server(persistent=False)
        try:
            art = lan.add("packages", self.proj, "nested lan", preferred_port=LAN_PORT, lan=True)
            if lan.host != "127.0.0.1":                      # the same answers over the LAN interface
                for rel, expect in (("api/config/secrets.yaml", 404), ("css/site.css", 200)):
                    status, _, _ = request(lan.port, "GET", f"/a/{art.id}/{rel}",
                                           host=f"{lan.host}:{lan.port}", address=lan.host)
                    self.assertEqual(status, expect, rel)
        finally:
            lan.shutdown()

    def test_personal_folders_under_home_are_workspace_roots(self):
        home = Path.home()
        for name in ("Downloads", "Documents", "Desktop"):
            self.assertTrue(A.is_workspace_root(home / name), name)
        self.assertFalse(A.is_workspace_root(home / "Downloads" / "report"))

    def test_the_tool_refuses_a_page_inside_any_dot_folder(self):
        before = set(self.srv.artifacts)
        for folder in (".github", ".storybook", ".next", ".secrets", ".terraform", "web/.private"):
            _write(self.proj / folder / "index.html", "<h1>hidden</h1>")
            _write(self.proj / folder / "deploy.yml", "token: SECRET")
            for path in (f"{folder}/index.html", folder):
                with self.assertRaises(PermissionError, msg=path):
                    self.srv.add(path, self.proj, preferred_port=REVIEW_PORT)
        self.assertEqual(set(self.srv.artifacts), before)

    def test_script_file_names_resolve_against_the_page_as_well(self):
        self.assertTrue(self.root.scoped)
        for rel, expect in (("data/sales.json", b"north"), ("js/worker.js", b"rows.json"),
                            ("js/chart.mjs", b"export"), ("js/rows.json", b"[4]"),
                            ("img/lazy.png", b"PNG lazy")):
            status, _, body = request(self.port, "GET", f"/a/{self.root.id}/{rel}")
            self.assertEqual(status, 200, rel)
            self.assertIn(expect, body)

    def test_a_scoped_page_does_not_publish_prose_mentions_or_secret_stores(self):
        for rel in ("notes.json", "google-services.json", "token.json", "appsettings.json",
                    "local.settings.json", "firebase-adminsdk-abc.json", "keyfile.json", "env.js",
                    "auth.json"):
            self.assertEqual(self.status(self.root, rel), 404, rel)

    def test_a_dedicated_folder_serves_server_side_files_only_when_a_page_links_them(self):
        self.assertFalse(self.pyapp.scoped)
        for rel in ("main.py", "pyscript.toml", "app.jsx", "db/app.sqlite"):
            self.assertEqual(self.status(self.pyapp, rel), 200, rel)
        for rel in ("db.sqlite-wal", "config.yaml", "app.ts", "terraform.tfstate.backup", "site.bak",
                    "data.db-journal", "vpn.ovpn", "server.py"):
            self.assertEqual(self.status(self.pyapp, rel), 404, rel)

    def test_quoted_entry_names_are_refused_and_the_frame_path_is_escaped(self):
        hostile = 'x" srcdoc="<img src=q onerror=alert(1)>" data-a=".html'
        try:
            _write(self.app / hostile, "<h1>x</h1>")
        except OSError:
            self.skipTest("file system refuses the name")
        with self.assertRaises(ValueError):
            self.srv.add(f"artifacts/pyapp/{hostile}", self.proj, preferred_port=REVIEW_PORT)
        shell = A._Server(persistent=False)
        legacy = A.Artifact(id="a" + "0" * 16, name="legacy", directory=str(self.app), entry=hostile)
        legacy._owner = shell
        shell.artifacts[legacy.id] = legacy
        page = A._shell_html(shell, legacy.id, "n")
        frame = re.search(r'<iframe id="frame" src="([^"]*)" title="artifact">', page)
        self.assertIsNotNone(frame, "the iframe keeps exactly its own attributes")
        self.assertNotIn('srcdoc="', page)

    def test_a_stalled_request_is_dropped(self):
        srv = A._Server(persistent=False)
        srv.request_timeout = 0.5
        try:
            art = srv.add("artifacts/pyapp", self.proj, "slow", preferred_port=REVIEW_PORT)
            with socket.create_connection(("127.0.0.1", srv.port), timeout=6) as sock:
                sock.sendall(f"GET /a/{art.id}/ HTTP/1.1\r\n".encode())
                started = time.monotonic()
                try:
                    data = sock.recv(1024)
                except socket.timeout:
                    data = None
                self.assertEqual(data, b"", "the server closes a request that never ends")
                self.assertLess(time.monotonic() - started, 4)
        finally:
            srv.shutdown()

    def test_linked_files_are_walked_once_and_follow_page_changes(self):
        site = self.proj / "gallery"
        _write(site / "package.json", "{}")             # a workspace root: scoped
        images = "".join(f'<img src="img/i{n}.png">' for n in range(300))
        _write(site / "index.html", images + '<img src="img/later.png">')
        for n in range(300):
            _write(site / "img" / f"i{n}.png", b"\x89PNG")
        art = self.srv.add("gallery/index.html", self.proj, "gallery", preferred_port=REVIEW_PORT)
        self.assertTrue(art.scoped)
        calls = []
        real_walk = A._walk_links

        def counting(*args, **kwargs):
            calls.append(args)
            return real_walk(*args, **kwargs)

        A._walk_links = counting
        try:
            for n in range(0, 300, 5):
                self.assertEqual(self.status(art, f"img/i{n}.png"), 200)
            self.assertEqual(len(calls), 1, "one walk serves every request while the page is unchanged")
            self.assertEqual(self.status(art, "img/later.png"), 404)
            _write(site / "img" / "later.png", b"\x89PNG later")      # written after its page
            self.assertEqual(self.status(art, "img/later.png"), 200)
            self.assertEqual(self.status(art, "img/new.png"), 404)
            _write(site / "img" / "new.png", b"\x89PNG new")
            _write(site / "index.html", images + '<img src="img/later.png"><img src="img/new.png">')
            self.assertEqual(self.status(art, "img/new.png"), 200)
            self.assertEqual(len(calls), 2)
        finally:
            A._walk_links = real_walk


if __name__ == "__main__":
    unittest.main()
