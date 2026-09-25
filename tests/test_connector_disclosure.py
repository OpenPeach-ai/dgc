"""What a user is told before they connect an account they own.

Three rules, each from a real gap found on 2026-09-25 reviewing the migrated plugin catalog.

The catalog offered seven packages whose licence field said MIT -- true of the PACKAGE, from
github.com/openai/plugins -- while saying nothing about the SERVICE whose account the user was
about to authorize. Stripe was worse: it named "Stripe service terms" and linked nothing. Only
Composio carried both links.

And a connector that executes in a vendor's cloud used to say so in one clause of a Requirements
paragraph that also covered accounts and Node.js. DGC's whole proposition is that the model can be
local; "your request still leaves this machine" is not a footnote to that.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
CATALOG = json.loads((ROOT / "dgc" / "plugin_catalog.json").read_text(encoding="utf-8"))
ROWS = CATALOG["plugins"] if isinstance(CATALOG, dict) else CATALOG
CONNECTORS = json.loads((ROOT / "dgc" / "connector_catalog.json").read_text(encoding="utf-8"))
SETTINGS_UI = (ROOT / "editors" / "vscode" / "src" / "settingsClient.js").read_text(encoding="utf-8")

# Connecting an account is exactly when a user needs to know whose terms apply.
ACCOUNT_AUTH = {"browser", "pat", "token"}


def installable(row) -> bool:
    """A blocked entry cannot be connected, so its disclosure is moot."""
    return row.get("install") != "block"


class ServiceTerms(unittest.TestCase):
    def test_every_connectable_entry_names_the_services_terms_and_privacy(self) -> None:
        missing = [r["name"] for r in ROWS
                   if installable(r) and r.get("auth") in ACCOUNT_AUTH
                   and not (r.get("terms_url") and r.get("privacy_url"))]
        self.assertEqual(missing, [], f"these connect an account with no service terms: {missing}")

    def test_a_package_licence_is_never_offered_as_the_services_terms(self) -> None:
        # MIT covers the package. It says nothing about Notion, Linear or GitHub, and showing it
        # alone invites the reader to think the licence question is settled.
        for row in ROWS:
            if installable(row) and row.get("auth") in ACCOUNT_AUTH and row.get("license") == "MIT":
                self.assertTrue(row.get("terms_url"),
                                f"{row['name']} shows an MIT package licence and no service terms")

    def test_every_connector_names_its_terms_and_privacy(self) -> None:
        for name, entry in CONNECTORS.items():
            self.assertTrue(entry.get("terms"), f"{name} has no terms link")
            self.assertTrue(entry.get("privacy"), f"{name} has no privacy link")

    def test_every_legal_link_is_a_plain_https_url(self) -> None:
        for row in ROWS:
            for field in ("terms_url", "privacy_url", "license_url"):
                url = row.get(field)
                if url:
                    self.assertRegex(url, r"^https://[^\s\"'<>]+$",
                                     f"{row['name']}.{field} is not a plain https URL")


class CloudExecution(unittest.TestCase):
    # n8n is the one connector a user may point at their own machine: its URL is theirs to choose,
    # and a self-hosted instance never leaves their network. Claiming otherwise would be a false
    # warning, which is its own kind of dishonesty -- its summary says where it can run instead.
    SELF_HOSTABLE = {"n8n"}

    def test_a_service_that_executes_remotely_declares_it(self) -> None:
        # The flag is the contract. Prose can be rewritten; a missing flag is detectable.
        for row in ROWS:
            if not installable(row) or row["name"] in self.SELF_HOSTABLE:
                continue
            if str(row.get("category", "")).endswith("connector"):
                self.assertTrue(row.get("cloud_execution"),
                                f"{row['name']} is a connector without cloud_execution")

    def test_the_self_hostable_exception_says_where_it_runs(self) -> None:
        connectors = CONNECTORS
        for name in self.SELF_HOSTABLE:
            text = f"{connectors[name].get('summary', '')} {connectors[name].get('setup', '')}".lower()
            self.assertIn("instance", text,
                          f"{name} is exempt from the cloud banner, so its own text must say "
                          f"where it runs")

    def test_the_notice_is_a_banner_driven_by_the_flag(self) -> None:
        self.assertIn("function cloudNotice(row)", SETTINGS_UI)
        notice = SETTINGS_UI[SETTINGS_UI.index("function cloudNotice(row)"):]
        notice = notice[:notice.index("function compatibilityDetails")]
        self.assertIn("row.cloud_execution", notice, "the notice must read the flag, not prose")
        self.assertIn('class="banner"', notice, "a footnote is not a disclosure")
        self.assertIn("runs on this computer", notice,
                      "it must name the case a local-model user would otherwise assume")

    def test_the_notice_precedes_the_requirements_paragraph(self) -> None:
        details = SETTINGS_UI[SETTINGS_UI.index("function compatibilityDetails"):]
        details = details[:details.index("\n}")]
        self.assertLess(details.index("cloudNotice(row)"), details.index("row.requirements"),
                        "the disclosure must come before the paragraph it used to hide in")


if __name__ == "__main__":
    unittest.main()
