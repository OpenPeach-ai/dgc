"""session.artifacts and output= through a real `dgc serve` (CLI 0.50+): every call is answered to its own request."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_dgc_sdk as harness                               # noqa: E402  (its mock model and setUp)

from dgc.artifact_store import Store                          # noqa: E402
from dgc_sdk import ArtifactInfo, DGCCommandRejectedError, DGCConfigError, DGCUnsupportedError  # noqa: E402

DECK = {"slides": [{"layout": "title", "title": "Q3 review"}]}


class SdkArtifacts(unittest.TestCase):
    # The SDK tests' own setup (a mock model, a throwaway host home and state), borrowed rather than inherited:
    # a subclass would run every one of their tests a second time.
    setUp = harness.SdkTests.setUp
    tearDown = harness.SdkTests.tearDown
    _client = harness.SdkTests._client

    def _seed(self):
        """Artifacts in the session's own isolated store (the child's DGC_HOME is <state>/home)."""
        store = Store(self.state / "home" / ".dgc" / "artifacts")
        doc = store.create("doc", "Plan", "# Plan\n\nOne.\n", origin={"surface": "work"})
        deck = store.create("slides", "Q3", DECK, origin={"surface": "chat", "chat": "c"})
        return doc, deck

    def test_list_get_content_update_restore_export_remove(self):
        doc, deck = self._seed()
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            arts = session.artifacts
            listed = arts.list()
            self.assertEqual({a.id for a in listed}, {doc.id, deck.id})
            self.assertIsInstance(listed[0], ArtifactInfo)
            self.assertEqual([a.title for a in arts.list(type="slides")], ["Q3"])
            got = arts.get(doc.id)
            self.assertEqual((got.type, got.version, got.versions[0].author), ("doc", 1, "DGC"))
            self.assertEqual(arts.content(doc.id), "# Plan\n\nOne.\n")
            changed = arts.update(doc.id, "# Plan\n\nTwo.\n", base_version=1, note="Mine")
            self.assertEqual((changed.version, changed.versions[-1].author), (2, "you"))
            self.assertIn("+Two.", arts.compare(doc.id, 1, 2)["diff"])
            with self.assertRaises(DGCCommandRejectedError):
                arts.update(doc.id, "stale", base_version=1)
            self.assertEqual(arts.restore(doc.id, 1).version, 3)
            path = arts.export(deck.id, "pptx")
            self.assertTrue(Path(path).is_file() and path.endswith(".pptx"))
            self.assertTrue(arts.open(doc.id).startswith("http://127.0.0.1:"))
            arts.remove(deck.id)
            self.assertEqual([a.id for a in arts.list()], [doc.id])

    def test_output_is_checked_before_anything_is_sent(self):
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            with self.assertRaises(DGCConfigError):
                session.stream("Make a deck", output="poster")
            result = session.run("Summarize README. Do not edit files.", output="auto", timeout=60)
            self.assertEqual(result.status, "completed")
            self.assertEqual(result.made_artifacts, [])

    def test_source_consent_is_version_checked_and_new_fields_are_capability_gated(self):
        from unittest.mock import patch
        store = Store(self.state / "home" / ".dgc" / "artifacts")
        old = {"sources": [{"id": "sales", "kind": "file", "path": "old.csv"}], "widgets": []}
        new = {"sources": [{"id": "sales", "kind": "file", "path": "new.csv"}], "widgets": []}
        dashboard = store.create("dashboard", "Sales", old, origin={"surface": "sdk"})
        store.update(dashboard.id, new)
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            with self.assertRaises(DGCCommandRejectedError) as caught:
                session.artifacts.allow_source(dashboard.id, "sales", base_version=1)
            self.assertEqual(caught.exception.reason, "conflict")
            self.assertEqual(store.get(dashboard.id).sources, [])
            session.artifacts.allow_source(dashboard.id, "sales", base_version=2)
            self.assertEqual(store.get(dashboard.id).sources, ["sales"])
            session.capabilities["artifacts"].pop("source_consent_version")
            session.capabilities["artifacts"].pop("compare")
            with patch.object(session, "_request") as request:
                with self.assertRaises(DGCUnsupportedError):
                    session.artifacts.allow_source(dashboard.id, "sales", base_version=2)
                with self.assertRaises(DGCUnsupportedError):
                    session.artifacts.compare(dashboard.id, 1, 2)
                request.assert_not_called()

    def test_the_async_api_answers_too(self):
        doc, _ = self._seed()

        async def go():
            async with harness.AsyncDGC(state_dir=self.state, model="sdk-model", base_url=self.base_url,
                                        api_key="sk-local") as dgc:
                session = await dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
                return [a.id for a in await session.artifacts.list(type="doc")]
        self.assertEqual(asyncio.run(go()), [doc.id])


    def test_the_typescript_sdk_lists_exports_and_refuses_a_stale_update(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node is not installed")
        doc, deck = self._seed()
        root = Path(__file__).resolve().parent.parent
        script = Path(tempfile.mkdtemp(prefix="dgc-ts-artifacts-")) / "artifacts.mjs"
        self.addCleanup(shutil.rmtree, script.parent, True)
        script.write_text(f"""
import {{ DGC }} from {json.dumps(str(root / 'sdk/typescript/src/index.ts'))};
const [stateDir, baseUrl, cwd] = process.argv.slice(2);
const dgc = new DGC({{ stateDir, model: 'sdk-model', baseUrl, apiKey: 'sk-local' }});
const session = await dgc.session({{ cwd, permissions: {{ mode: 'auto', unhandled: 'deny' }} }});
const listed = await session.artifacts.list();
const slides = await session.artifacts.list({{ type: 'slides' }});
const path = await session.artifacts.export(slides[0].id, 'pptx');
const doc = listed.find((a) => a.type === 'doc');
const changed = await session.artifacts.update(doc.id, '# Plan\\n\\nTwo.\\n', {{ baseVersion: 1 }});
const comparison = await session.artifacts.compare(doc.id, 1, 2);
let stale = '';
try {{ await session.artifacts.update(doc.id, 'x', {{ baseVersion: 1 }}); }} catch (e) {{ stale = String(e.reason || e.name); }}
console.log(JSON.stringify({{ ids: listed.map((a) => a.id).sort(), path, version: changed.version,
  author: changed.versions.at(-1).author, comparison, stale }}));
await dgc.close();
""")
        env = {**os.environ, "DGC_PYTHON": sys.executable, "PYTHONPATH": str(root)}
        done = subprocess.run([node, str(script), str(self.state), self.base_url, str(self.work)], env=env,
                              capture_output=True, text=True, timeout=240)
        self.assertEqual(done.returncode, 0, done.stderr[-3000:])
        got = json.loads(done.stdout.strip().splitlines()[-1])
        self.assertEqual(got["ids"], sorted([doc.id, deck.id]))
        self.assertTrue(got["path"].endswith(".pptx"))
        self.assertEqual((got["version"], got["author"]), (2, "you"))
        self.assertIn("+Two.", got["comparison"]["diff"])
        self.assertIn("conflict", got["stale"].lower())


if __name__ == "__main__":
    unittest.main()
