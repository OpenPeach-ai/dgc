"""Images handed to the backend as files instead of base64 inside the protocol frame.

A pasted image used to ride inside the JSON command as a data URI. The command frame is capped at
4 MiB (editor_protocol.MAX_COMMAND_BYTES) and has to hold the prompt text and context resources
too, with base64 inflating the bytes by ~4/3 -- which is where the editor's 2 MiB image ceiling
and its 4-image count limit came from. Neither is a statement about what a model can accept.

These tests are about the boundary, not the pixels: only files in the backend's own spool, only
real images, bounded, and gone from disk afterwards either way.
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc.attachments import (MAX_SPOOLED_IMAGE_ENTRIES, MAX_SPOOLED_IMAGE_FILE_BYTES,
                             MAX_SPOOLED_IMAGE_TOTAL_BYTES, read_spooled_images)

PNG = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
JPEG = (b"\xff\xd8\xff" + b"\x00" * 64)


class SpoolTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def put(self, name: str, raw: bytes = PNG) -> str:
        (self.root / name).write_bytes(raw)
        return name

    def entry(self, name: str, mime: str = "image/png") -> dict:
        return {"name": name, "media_type": mime}

    def test_a_spooled_image_becomes_a_data_uri(self):
        out = read_spooled_images([self.entry(self.put("a.png"))], self.root)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].startswith("data:image/png;base64,"))
        self.assertEqual(base64.b64decode(out[0].split(",", 1)[1]), PNG)

    def test_the_file_is_gone_afterwards(self):
        # The spool is a hand-over, not a store.
        name = self.put("a.png")
        read_spooled_images([self.entry(name)], self.root)
        self.assertFalse((self.root / name).exists())

    def test_a_rejected_batch_does_not_leave_files_behind(self):
        good, bad = self.put("a.png"), self.put("b.png", b"not an image at all")
        with self.assertRaises(ValueError):
            read_spooled_images([self.entry(good), self.entry(bad)], self.root)
        self.assertFalse((self.root / good).exists(), "the one already read is still consumed")
        self.assertFalse((self.root / bad).exists(), "and so is the one that failed")

    def test_more_than_four_images_is_fine_now(self):
        # The old count limit existed only to keep the protocol frame small.
        entries = [self.entry(self.put(f"i{n}.png")) for n in range(12)]
        self.assertEqual(len(read_spooled_images(entries, self.root)), 12)

    def test_the_aggregate_budget_still_bites(self):
        big = b"\x89PNG\r\n\x1a\n" + b"\x00" * (MAX_SPOOLED_IMAGE_FILE_BYTES - 8)
        entries = [self.entry(self.put(f"b{n}.png", big)) for n in range(6)]
        with self.assertRaises(ValueError) as caught:
            read_spooled_images(entries, self.root)
        self.assertIn("aggregate", str(caught.exception))

    def test_a_single_image_over_its_ceiling_is_refused(self):
        huge = b"\x89PNG\r\n\x1a\n" + b"\x00" * (MAX_SPOOLED_IMAGE_FILE_BYTES + 1)
        with self.assertRaises(ValueError):
            read_spooled_images([self.entry(self.put("h.png", huge))], self.root)

    def test_the_entry_count_is_bounded(self):
        entries = [self.entry("x.png")] * (MAX_SPOOLED_IMAGE_ENTRIES + 1)
        with self.assertRaises(ValueError) as caught:
            read_spooled_images(entries, self.root)
        self.assertIn("entry limit", str(caught.exception))

    # --- the boundary ----------------------------------------------------------------------------

    def test_a_name_cannot_escape_the_spool(self):
        outside = self.root.parent / "secret.png"
        outside.write_bytes(PNG)
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        for name in ("../secret.png", "..", ".", "sub/a.png", str(outside)):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    read_spooled_images([self.entry(name)], self.root)
        self.assertTrue(outside.exists(), "and nothing outside the spool was deleted either")

    def test_an_absolute_path_is_refused_even_inside_the_spool(self):
        # Refused by shape, not normalised: there is no arithmetic here to get wrong.
        name = self.put("a.png")
        with self.assertRaises(ValueError):
            read_spooled_images([self.entry(str(self.root / name))], self.root)

    @unittest.skipUnless(hasattr(os, "symlink"), "needs symlinks")
    def test_a_symlink_out_of_the_spool_is_refused(self):
        secret = self.root.parent / "target.png"
        secret.write_bytes(PNG)
        self.addCleanup(lambda: secret.unlink(missing_ok=True))
        os.symlink(secret, self.root / "link.png")
        with self.assertRaises(ValueError):
            read_spooled_images([self.entry("link.png")], self.root)
        self.assertTrue(secret.exists())

    def test_the_bytes_must_match_the_declared_type(self):
        name = self.put("a.png", JPEG)          # JPEG bytes declared as PNG
        with self.assertRaises(ValueError) as caught:
            read_spooled_images([self.entry(name)], self.root)
        self.assertIn("does not match", str(caught.exception))

    def test_an_unsupported_media_type_is_refused(self):
        with self.assertRaises(ValueError):
            read_spooled_images([self.entry(self.put("a.svg"), "image/svg+xml")], self.root)

    def test_a_missing_file_is_a_refusal_not_a_crash(self):
        with self.assertRaises(ValueError):
            read_spooled_images([self.entry("nothing.png")], self.root)

    def test_nothing_spooled_is_nothing_read(self):
        self.assertEqual(read_spooled_images(None, self.root), ())
        self.assertEqual(read_spooled_images([], self.root), ())

    def test_a_non_list_is_refused(self):
        with self.assertRaises(ValueError):
            read_spooled_images({"name": "a.png"}, self.root)


class UnchangedElsewhereTest(unittest.TestCase):
    """The other callers of the image validator must keep the bounds they had.

    dgc/acp.py calls validate_image_data_uris with every default, so the 4-image count limit is
    the ONLY bound an ACP client (Zed and friends) has. Raising the editor's ceiling must not
    reach it, and the terminal's @path budget is separate again.
    """

    def test_the_inline_validator_still_refuses_a_fifth_image(self):
        from dgc.attachments import MAX_IMAGE_FILES, validate_image_data_uris
        uri = "data:image/png;base64," + base64.b64encode(PNG).decode()
        with self.assertRaises(ValueError):
            validate_image_data_uris([uri] * (MAX_IMAGE_FILES + 1))

    def test_acp_passes_no_overrides_so_it_keeps_the_default_bounds(self):
        import inspect

        from dgc import acp
        source = inspect.getsource(acp._prompt_images)
        self.assertIn("validate_image_data_uris(out)", source,
                      "ACP relies on the defaults; an override here would silently unbound it")

    def test_the_spool_budget_is_larger_than_the_inline_one(self):
        from dgc.attachments import MAX_EDITOR_IMAGE_TOTAL_BYTES
        self.assertGreater(MAX_SPOOLED_IMAGE_TOTAL_BYTES, MAX_EDITOR_IMAGE_TOTAL_BYTES)
        self.assertEqual(MAX_SPOOLED_IMAGE_TOTAL_BYTES, 32 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()


class BackendWiringTest(unittest.TestCase):
    """The prompt path must not reach for the spool when no prompt uses it."""

    def test_a_prompt_without_spooled_images_never_builds_the_spool(self):
        # The unit harness assembles a Backend with object.__new__ and only the attributes a path
        # touches, so a spool built eagerly on every prompt crashed on a missing `config`. It is
        # also simply wrong to mkdir once per message.
        import inspect

        from dgc import headless
        source = inspect.getsource(headless.Backend._dispatch)
        self.assertIn("if spooled:", source,
                      "the spool must be reached for only when spooled_images is present")

    def test_the_spool_survives_a_backend_with_no_config(self):
        from dgc import headless
        backend = object.__new__(headless.Backend)
        self.assertTrue(str(backend._image_spool()))


class ProtocolShapeTest(unittest.TestCase):
    """Where a new piece of information is allowed to live on an existing event.

    `ready` has a declared field list and the SDK refuses the whole event over an undeclared one --
    "backend violated protocol v14: ready has an undeclared field" -- which took out every SDK test
    at once. `capabilities` is an open object the validator only type-checks, and is the place for
    this. The rule is worth a test because the failure is remote from the change.
    """

    def test_ready_declares_no_image_spool_field_of_its_own(self):
        from dgc.editor_protocol import EVENT_FIELDS
        self.assertNotIn("image_spool_dir", EVENT_FIELDS["ready"],
                         "a new top-level field on ready is fatal to a client that has not opted in")

    def test_the_spool_is_advertised_inside_capabilities(self):
        import inspect

        from dgc import headless
        source = inspect.getsource(headless.Backend)
        self.assertIn('"image_spool_dir": str(self._image_spool())', source)

    def test_a_ready_event_with_the_capability_still_validates(self):
        from dgc.editor_protocol import event_error
        frame = {
            "type": "ready", "seq": 0, "version": "0.42.0", "protocol_version": 14,
            "capabilities": {"image_spool": True, "image_spool_dir": "/tmp/spool"},
            "model": "m", "mode": "auto", "think": "off", "base_url": "http://127.0.0.1:1/v1",
            "workspace_trusted": True, "commands": [], "custom_commands": [],
            "goal": {"text": "", "status": "none"}, "context_size": 1, "session_id": "s1",
        }
        # Fill in whatever else the spec demands, so this test is about the capability map only.
        from dgc.editor_protocol import EVENT_FIELDS
        for name, field in EVENT_FIELDS["ready"].items():
            if name in frame or not field["required"]:
                continue
            kinds = field["types"]
            frame[name] = ("" if "string" in kinds else 0 if "integer" in kinds
                           else False if "boolean" in kinds else [] if "array" in kinds else {})
            if "enum" in field:
                frame[name] = field["enum"][0]
        self.assertIsNone(event_error(frame), "the capability map must not make ready invalid")
