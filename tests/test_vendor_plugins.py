"""The vendors' own plugins in DGC's catalog (researched and probed 2026-10-07).

Vendors publish one package in several formats (Claude, Codex, Cursor, and the open Agent Plugins
standard at the root), and DGC reads all of them. The catalog may set a package's servers when the
vendor's file names a per-account placeholder, a pasted key where sign-in works, or nothing at all.
Every connector is the vendor's hosted server: nothing for the user to download.
"""
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import plugins
from dgc.config import persisted_mcp_args_safe, valid_remote_mcp_url
from dgc.mcp import MCPInputError, sanitize_input_request


def write(root: Path, relative: str, text: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def skill(root: Path, folder: str, name: str) -> None:
    write(root, f"{folder}/SKILL.md", f"---\nname: {name}\ndescription: {name} things\n---\nDo {name}.\n")


class VendorPackageFormatTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def test_a_cursor_package_with_mcp_json_is_read(self):
        # Mobbin, Adspirer, Context.dev and Harmonic ship only .cursor-plugin/plugin.json and mcp.json.
        write(self.root, ".cursor-plugin/plugin.json", json.dumps(
            {"name": "adspirer", "displayName": "Adspirer", "license": "MIT", "skills": "./skills/",
             "rules": "./rules/", "mcpServers": "./mcp.json", "logo": "assets/icon.png"}))
        write(self.root, "mcp.json", json.dumps({"mcpServers": {"adspirer": {"type": "http", "url": "https://mcp.adspirer.com/mcp"}}}))
        skill(self.root, "skills/ad-campaigns", "ad-campaigns")
        write(self.root, "rules/usage.mdc", "Use it well.")
        preview = plugins._preview({"name": "adspirer", "display_name": "Adspirer"}, self.root)
        self.assertEqual([s["name"] for s in preview["skills"]], ["ad-campaigns"])
        self.assertEqual(preview["server_specs"]["adspirer"]["url"], "https://mcp.adspirer.com/mcp")
        self.assertIn("rules: this host-specific component is not imported by DGC.", preview["warnings"])
        self.assertEqual(plugins._declared_license(self.root), "MIT")

    def test_an_agent_plugins_package_at_the_root_is_read(self):
        # Ando and AWS Core use the open Agent Plugins standard: plugin.json at the root.
        write(self.root, "plugin.json", json.dumps({"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
                                                    "name": "ando", "license": "MIT"}))
        write(self.root, "mcp.json", json.dumps({"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
                                                 "mcpServers": {"ando": {"type": "streamable-http", "url": "https://mcp.ando.so/mcp"}}}))
        skill(self.root, "skills/ando", "ando")
        preview = plugins._preview({"name": "ando"}, self.root)
        self.assertEqual(list(preview["server_specs"]), ["ando"])
        self.assertEqual(preview["skills"][0]["name"], "ando")

    def test_the_catalog_sets_a_packages_servers_when_the_vendor_file_cannot_be_used(self):
        # ActiveCampaign's file names "${user_config.server_url}"; Antimetal's Cursor file wants a pasted key.
        write(self.root, ".claude-plugin/plugin.json", json.dumps({"name": "activecampaign"}))
        write(self.root, ".mcp.json", json.dumps({"mcpServers": {"activecampaign": {"type": "http", "url": "${user_config.server_url}"}}}))
        entry = {"name": "activecampaign", "mcp_presets": {"activecampaign": {"url": "https://mcp.app-us1.com/http"}}}
        specs = plugins._read_server_specs(self.root, entry)
        self.assertEqual(specs["activecampaign"]["args"][:3], ["-y", "mcp-remote", "https://mcp.app-us1.com/http"])

    def test_a_server_that_needs_a_scope_at_sign_in_gets_it(self):
        # Plain answers 403 after a sign-in that looked fine unless the client asked for these scopes.
        specs = plugins._read_server_specs(None, {"name": "plain", "mcp_presets": {"plain": {
            "url": "https://mcp.plain.com/mcp", "oauth_scope": "openid offline_access"}}})
        args = specs["plain"]["args"]
        metadata = json.loads(args[args.index("--static-oauth-client-metadata") + 1])
        self.assertEqual(metadata, {"client_name": "DGC", "client_uri": "https://vibedgc.com", "scope": "openid offline_access"})
        with self.assertRaises(plugins.PluginError):
            plugins._read_server_specs(None, {"name": "x", "mcp_presets": {"x": {"url": "https://x.example/mcp", "oauth_scope": "a;rm -rf"}}})

    def test_a_skill_named_twice_by_its_manifest_is_one_skill(self):
        # Adobe App Builder lists ./skills/ and, again, three folders inside it.
        write(self.root, ".claude-plugin/plugin.json", json.dumps({"name": "app-builder", "skills": [
            "./skills/", "./skills/workfront/workfront-actions"]}))
        skill(self.root, "skills/project-init", "project-init")
        skill(self.root, "skills/workfront/workfront-actions", "workfront-actions")
        self.assertEqual(sorted(f.parent.name for f in plugins._skill_files(self.root)), ["project-init", "workfront-actions"])

    def test_a_package_pinned_at_its_skills_folder_is_its_skills(self):
        # Astronomer's repository has symlinks and Appwrite's a 23 MB logo: DGC fetches only skills/.
        skill(self.root, "airflow", "airflow")
        skill(self.root, "dags", "dags")
        self.assertEqual(sorted(f.parent.name for f in plugins._skill_files(self.root)), ["airflow", "dags"])

    def test_sse_and_unknown_transports_are_refused(self):
        for kind in ("sse", "websocket"):
            with self.subTest(kind=kind), self.assertRaises(plugins.PluginError):
                plugins._read_server_specs(None, {"name": "x", "mcp_presets": {"x": {"type": kind, "url": "https://x.example/mcp"}}})


class HostedServerAddressTests(unittest.TestCase):
    def test_awss_public_oauth_switch_is_not_a_secret(self):
        url = "https://aws-mcp.us-east-1.api.aws/mcp?oauth=initialize"
        self.assertTrue(valid_remote_mcp_url(url))
        self.assertTrue(persisted_mcp_args_safe(["-y", "mcp-remote", url]))
        for unsafe in (["-y", "mcp-remote", "https://x.example/mcp?oauth=abc123"],
                       ["-y", "mcp-remote", "https://x.example/mcp?token=initialize"],
                       ["-y", "mcp-remote", "https://user:pass@x.example/mcp"],
                       ["--token", "https://x.example/mcp"], ["--header", "https://x.example/mcp"]):
            with self.subTest(args=unsafe):
                self.assertFalse(persisted_mcp_args_safe(unsafe))

    def test_a_sign_in_link_with_many_scopes_is_shown(self):
        # Airwallex's sign-in link lists every scope it supports and runs past 2,000 characters.
        url = "https://mcp.sandbox.airwallex.com/developer/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A35272%2Foauth%2Fcallback&scope=" + "+".join(f"r:awx_action:scope_{n}_view" for n in range(120))
        self.assertGreater(len(url), 2048)
        self.assertEqual(sanitize_input_request("elicitation/create", {"mode": "url", "url": url, "message": "Sign in"})["url"], url)
        with self.assertRaises(MCPInputError):
            sanitize_input_request("elicitation/create", {"mode": "url", "url": url + "x" * 8192, "message": "Sign in"})


class VendorCatalogTests(unittest.TestCase):
    def setUp(self):
        self.entries = json.loads(plugins.CATALOG_PATH.read_text())["plugins"]
        self.vendor = [e for e in self.entries if e.get("audited_on") == "2026-10-07"]

    def test_the_vendors_official_plugins_are_offered(self):
        names = {e["name"] for e in self.vendor}
        self.assertEqual(len(self.vendor), 41)
        self.assertTrue({"airtable", "granola", "intercom", "apollo", "attio", "amplitude", "aws-core", "1inch", "aave",
                         "airwallex-agentos", "adobe-app-builder"} <= names)
        self.assertNotIn("aikido", names, "no hosted server: only local connectors, which DGC does not offer")

    def test_every_connector_is_the_vendors_hosted_server(self):
        for entry in self.vendor:
            with self.subTest(entry=entry["name"]):
                self.assertEqual(entry["install"], "allow")
                if entry["source_kind"] == "vendor":
                    self.assertRegex(entry["sha"], r"\A[0-9a-f]{40}\Z", "pinned to a reviewed commit")
                    self.assertIn(entry["license"], ("MIT", "Apache-2.0", "BSD-3-Clause"))
                for server in (entry.get("mcp_presets") or {}).values():
                    self.assertTrue(server.get("url", "").startswith("https://"), "a hosted server, never a local program")
                    self.assertNotIn("command", server)
                if entry["auth"] != "none":
                    self.assertTrue(entry.get("terms_url") and entry.get("privacy_url"))
                # Settings prints "Checked <audited_on>." before this text: say what was checked, once.
                self.assertTrue(entry["verification"] and not entry["verification"].startswith("Checked"), entry["verification"])

    def test_payment_plugins_say_money_moves_and_are_marked(self):
        money = {e["name"] for e in self.vendor if e.get("risk") == "money"}
        self.assertEqual(money, {"1inch", "aave", "airwallex-agentos"})
        for entry in self.vendor:
            if entry["name"] in money:
                self.assertRegex(entry["summary"], r"waits for your Allow")

    def test_offered_vendor_plugins_appear_in_the_editor_catalog(self):
        with patch.object(plugins, "load_catalog", return_value={"plugins": self.entries}), \
             patch.object(plugins, "_installed", return_value=[]), \
             patch.object(plugins, "_source", side_effect=plugins.PluginError("not cached")):
            rows = {r["name"]: r for r in plugins.catalog_for_editor()}
        self.assertEqual(rows["granola"]["category"], "Documents And Files")
        self.assertIn("opens Airtable's own login page", rows["airtable"]["verification"])
        self.assertEqual(rows["airtable"]["audited_on"], "2026-10-07")
        self.assertEqual(rows["brevo"]["auth"], "pat")


if __name__ == "__main__":
    unittest.main()
