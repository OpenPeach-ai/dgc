"""Files in a Pip's chat: text, code and documents, kept once, listed by name, read the main
chat's way (documents to text, credentials redacted), and put in a Pip's computer when it has one."""
import base64
import io
import json
import os
import unittest
import zipfile
from unittest.mock import patch

from dgc import pip_chat, pip_computer, pip_computer_files as desk, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


def uri(raw: bytes, mime="application/octet-stream") -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


def docx(text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" '
                   'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                   'Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                   f'<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
    return buf.getvalue()


NOTES = {"name": "broker notes.txt", "data": uri(b"Sold 5 TCS at 4120.\n")}
PLAN = {"name": "plan.docx", "data": uri(docx("Quarterly plan: hire two people."))}


class PipChatFileTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def pip(self, computer=False):
        pip = self.store.create(self.registry.personal()["id"], "Money", None, "editor-user", pip_type="lens")
        if computer:
            proposal = self.store.propose(pip["id"], 1, {"computer_plan": {"schema_version": 1}}, "local-console")
            self.store.accept(pip["id"], proposal["id"], 1, "local-console")
        return self.store.get(pip["id"])

    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_files_are_kept_once_privately_and_listed_by_name(self):
        pip = self.pip()
        sent = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "What changed?",
                             "idempotency_key": "k1", "files": [NOTES, PLAN]})
        self.assertTrue(sent["ok"], sent.get("error"))
        self.assertEqual([(f["name"], f["index"]) for f in sent["result"]["message"]["files"]],
                         [("broker notes.txt", 0), ("plan.docx", 1)])
        kept = sorted(pip_chat.file_directory(self.registry.directory, pip["id"]).iterdir())
        self.assertEqual(len(kept), 2)
        self.assertTrue(all(oct(p.stat().st_mode & 0o777) == "0o600" for p in kept))
        [message] = pip_chat.list_messages(self.store, pip["id"])["messages"]
        self.assertEqual(message["files"][1]["name"], "plan.docx")
        self.assertNotIn("data", json.dumps(message["files"]))
        alone = self.control({"type": "send_pip_message", "pip_id": self.pip()["id"], "text": "", "idempotency_key": "k2", "files": [NOTES]})
        self.assertEqual(alone["result"]["message"]["text"], pip_chat.FILE_ONLY_TEXT)

    def test_what_is_not_a_readable_file_is_refused_and_nothing_is_kept(self):
        pip = self.pip()
        cases = {"a program": [{"name": "setup.exe", "data": uri(b"MZ...")}],
                 "a folder in the name": [{"name": "../notes.txt", "data": uri(b"x")}],
                 "a quote in the name": [{"name": 'a".txt', "data": uri(b"x")}],
                 "a document that is not one": [{"name": "plan.docx", "data": uri(b"just text")}],
                 "binary text": [{"name": "notes.txt", "data": uri(b"\0\1\2")}],
                 "empty": [{"name": "empty.txt", "data": uri(b"")}],
                 "five files": [NOTES] * 5,
                 "over 2 MB": [{"name": "big.txt", "data": uri(b"x" * (2 * 1024 * 1024 + 1))}],
                 "not a data URI": [{"name": "a.txt", "data": "https://example.com/a.txt"}]}
        for name, files in cases.items():
            with self.subTest(name):
                refused = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "hi",
                                        "idempotency_key": "k-" + str(abs(hash(name)) % 10**6), "files": files})
                self.assertFalse(refused["ok"])
        folder = pip_chat.file_directory(self.registry.directory, pip["id"])
        self.assertFalse(folder.exists() and any(folder.iterdir()))
        self.assertEqual(pip_chat.list_messages(self.store, pip["id"])["messages"], [])

    def test_a_retry_key_binds_its_files(self):
        pip = self.pip()
        first = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "Read", "idempotency_key": "k1", "files": [NOTES]})
        again = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "Read", "idempotency_key": "k1", "files": [NOTES]})
        self.assertEqual(again["result"]["run"]["id"], first["result"]["run"]["id"])
        renamed = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "Read", "idempotency_key": "k1",
                                "files": [{**NOTES, "name": "other.txt"}]})
        self.assertFalse(renamed["ok"], "the same key with another file is another request")

    def test_files_and_images_share_one_2_mb_budget_through_the_transport(self):
        from dgc.headless import _bounded_pips_command
        pip = self.pip()
        photo = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 900_000).decode()
        text = {"name": "log.txt", "data": uri(b"a" * 900_000)}
        request = {"type": "send_pip_message", "pip_id": pip["id"], "text": "Both", "idempotency_key": "k1",
                   "images": [photo], "files": [text], "request_id": "r1"}
        bounded = _bounded_pips_command({"type": "pips_control", "request": request})
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            sent = pips.handle_control(self.cfg, bounded["request"], "editor-user", start_worker=False)
        self.assertTrue(sent["ok"], sent.get("error"))
        self.assertEqual(len(sent["result"]["message"]["files"]), 1)
        self.assertEqual(len(sent["result"]["message"]["images"]), 1)
        with self.assertRaises(RegistryError):
            _bounded_pips_command({"type": "pips_control", "request": {**request, "files": [text, {**text, "name": "b.txt"}]}})

    def test_the_pip_reads_them_the_main_chats_way_with_credentials_redacted(self):
        from dgc.llm import LLMClient, ChatResult
        pip = self.pip()
        leaked = {"name": "keys.txt", "data": uri(b"my key is tangerine-umbrella-cascade-41\n")}
        run = pip_chat.send(self.store, pip["id"], "Summarise these", "k1", "user", self.cfg, files=[NOTES, PLAN, leaked])["run"]
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        self.assertNotIn("Sold 5 TCS", json.dumps(raw), "the bytes never ride in the manifest")
        paths = [str(p) for p in pip_chat.file_paths(self.registry.directory, pip["id"], raw["conversation"]["files"])]
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append(json.dumps(messages))
            return ChatResult(content="Done.")

        def go(manifest):
            with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                    patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                    patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
                return pips.execute_native(self.cfg, self.root, manifest, lambda e: None)
        # A live credential DGC knows that no pattern would spot: only its known-secret redaction catches it.
        self.cfg._session_secret_values = ("tangerine-umbrella-cascade-41",)
        go({**raw, "conversation_file_paths": paths})
        prompt = seen[0]
        self.assertIn("Sold 5 TCS at 4120.", prompt)
        self.assertIn("Quarterly plan: hire two people.", prompt, "a Word document arrives as its text")
        self.assertIn("broker notes.txt", prompt)
        self.assertIn("untrusted", prompt)
        self.assertNotIn("tangerine-umbrella-cascade-41", prompt, "configured credentials are redacted, as in the main chat")
        import shutil, tempfile
        elsewhere = os.path.join(tempfile.mkdtemp(dir=self.root), "copy")
        shutil.copyfile(paths[0], elsewhere)
        with self.assertRaises(RegistryError):
            go({**raw, "conversation_file_paths": [elsewhere, *paths[1:]]})
        with open(paths[0], "ab") as tamper:
            tamper.write(b"x")
        with self.assertRaises(RegistryError):
            pip_chat.file_paths(self.registry.directory, pip["id"], raw["conversation"]["files"])
        with self.assertRaises(RegistryError):
            go({**raw, "conversation_file_paths": paths})
        with self.assertRaises(RegistryError):
            go({**raw, "conversation_file_paths": ["/etc/passwd"] * 3})

    def test_a_pip_with_a_computer_finds_them_in_its_files(self):
        pip = self.pip(computer=True)
        pip_chat.send(self.store, pip["id"], "Keep these", "k1", "user", self.cfg, files=[NOTES])
        folder = desk.files_root(pip_computer.computer_root(self.registry.directory, pip["id"]))
        self.assertEqual((folder / "From chat" / "broker notes.txt").read_bytes(), b"Sold 5 TCS at 4120.\n")
        os.rename(folder / "From chat", folder / "elsewhere")
        os.symlink(folder / "elsewhere", folder / "From chat")
        self.store.finish(self.store.claim_next()["id"], result={"text": "Kept."})
        sent = pip_chat.send(self.store, pip["id"], "And this", "k3", "user", self.cfg, files=[PLAN])
        self.assertTrue(sent["message"]["files"], "a link where the folder was never stops the message")
        self.assertFalse((folder / "elsewhere" / "plan.docx").exists(), "and nothing is written through it")


if __name__ == "__main__":
    unittest.main()
