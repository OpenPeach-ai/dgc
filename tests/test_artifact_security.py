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
import unittest
from pathlib import Path

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    # Run standalone: never read or rewrite the developer's real ~/.dgc registry.
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

import dgc.artifacts as A  # noqa: E402

MAIN_PORT, PLAN_PORT, LAN_PORT, AGENT_PORT = 5031, 5033, 5035, 5037
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


if __name__ == "__main__":
    unittest.main()
