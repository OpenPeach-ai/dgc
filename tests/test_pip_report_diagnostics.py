"""Audit parse failures expose safe diagnostics, never the rejected response."""
from __future__ import annotations

import json
import tempfile
import traceback
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pips
from dgc.workspace_registry import RegistryError


class PipReportDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="dgc-report-diagnostic-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "source.py").write_text("def answer():\n    return 42\n", encoding="utf-8")

    def parse(self, text, *, read_calls=1):
        return pips.validate_report(text, self.root, read_calls=read_calls)

    def invalid(self, text):
        with self.assertRaises(RegistryError) as failure:
            self.parse(text)
        self.assertEqual(failure.exception.code, "invalid_report")
        return failure.exception

    def test_plain_valid_report_and_existing_json_fence_are_unchanged(self):
        report = {"summary": "Inspected source", "findings": [{"title": "Review boundary", "severity": "low",
                  "path": "source.py", "line": 2, "evidence": "    return 42"}], "limitations": ["No tests run"]}
        raw = json.dumps(report)
        first = self.parse(raw)
        self.assertEqual(self.parse("\n```json\n" + raw + "\n```\n"), first)
        self.assertEqual(first["findings"][0]["verification"], "source_excerpt_only")
        self.assertIs(first["tests_executed"], False)
        self.assertEqual(first["findings"][0]["evidence"], report["findings"][0]["evidence"])

    def test_missing_optional_limitations_keeps_existing_semantics(self):
        self.assertEqual(self.parse('{"summary":"Reviewed","findings":[]}')["limitations"], [])

    def test_expected_property_reports_line_column_and_size_only(self):
        raw = '{"summary":"private-response-value",\nfindings: []}'
        error = self.invalid(raw)
        self.assertIn("expected a double-quoted property name at JSON line 2, column 1", str(error))
        self.assertIn(f"({len(raw.encode('utf-8'))} UTF-8 bytes)", str(error))
        self.assertIn("Return one JSON object", str(error))
        self.assertNotIn("private-response-value", str(error))

    def test_plain_prose_fails_without_echo_or_automatic_retry(self):
        raw = "PRIVATE_RESPONSE_TOKEN: this is prose, not a JSON audit."
        original = pips.json.loads
        with patch.object(pips.json, "loads", wraps=original) as decode:
            error = self.invalid(raw)
        self.assertEqual(decode.call_count, 1)
        self.assertIn("expected a JSON value at JSON line 1, column 1", str(error))
        self.assertNotIn(raw, str(error))
        self.assertNotIn("PRIVATE_RESPONSE_TOKEN", str(error))

    def test_trailing_content_and_generic_fences_still_fail_closed(self):
        report = '{"summary":"Reviewed","findings":[]}'
        error = self.invalid(report + " PRIVATE_TRAILING_TOKEN")
        self.assertIn("content appears after the JSON value", str(error))
        self.assertNotIn("PRIVATE_TRAILING_TOKEN", str(error))
        self.invalid("```\n" + report + "\n```")
        self.invalid("Introduction\n" + report)
        self.invalid(report + report)

    def test_control_and_escape_diagnostics_never_print_input_tokens(self):
        for raw, category in ((r'{"summary":"PRIVATE\q","findings":[]}', "invalid escape"),
                              ('{"summary":"PRIVATE\x01","findings":[]}', "unescaped control character"),
                              (r'{"summary":"PRIVATE\uZZZZ","findings":[]}', "invalid Unicode escape")):
            with self.subTest(category=category):
                error = self.invalid(raw)
                self.assertIn(category, str(error))
                self.assertNotIn("PRIVATE", str(error))
                self.assertNotIn("\x01", str(error))

    def test_unknown_parser_message_is_not_echoed_in_error_or_traceback(self):
        secret = "PRIVATE_DECODER_TOKEN"
        error = json.JSONDecodeError("Unknown parser error containing " + secret, secret, 3)
        with patch.object(pips.json, "loads", side_effect=error):
            try:
                self.parse('{"summary":"Reviewed","findings":[]}')
            except RegistryError as failure:
                rendered = "".join(traceback.format_exception(type(failure), failure, failure.__traceback__))
                self.assertIn("malformed JSON", str(failure))
                self.assertNotIn(secret, str(failure))
                self.assertNotIn(secret, rendered)
                self.assertTrue(failure.__suppress_context__)
            else:
                self.fail("Unknown parser errors must fail closed")

    def test_recursion_has_generic_depth_diagnostic_without_parser_text(self):
        with patch.object(pips.json, "loads", side_effect=RecursionError("PRIVATE_DEPTH_DETAILS")):
            error = self.invalid('[[]]')
        self.assertIn("JSON nesting limit", str(error))
        self.assertIn("shallow JSON object", str(error))
        self.assertNotIn("PRIVATE_DEPTH_DETAILS", str(error))

    def test_non_jsondecode_value_error_does_not_echo_numeric_or_parser_details(self):
        with patch.object(pips.json, "loads", side_effect=ValueError("PRIVATE_BAD_NUMBER")):
            error = self.invalid('{"summary":"Reviewed","findings":[]}')
        self.assertIn("unsupported JSON value", str(error))
        self.assertNotIn("PRIVATE_BAD_NUMBER", str(error))

    def test_character_limit_precedes_encoding_stripping_and_json_allocation(self):
        class MustNotCopy(str):
            def encode(self, *_args, **_kwargs):
                raise AssertionError("oversized string was encoded")
            def strip(self, *_args, **_kwargs):
                raise AssertionError("oversized string was normalized")
        with patch.object(pips.json, "loads", side_effect=AssertionError("oversized string was parsed")):
            error = self.invalid(MustNotCopy("x" * 32001))
        self.assertIn("32000-byte input budget", str(error))

    def test_exact_byte_budget_still_accepts_valid_json_with_whitespace(self):
        report = '{"summary":"Reviewed","findings":[]}'
        raw = report + " " * (32000 - len(report))
        self.assertEqual(len(raw.encode("utf-8")), 32000)
        self.assertEqual(self.parse(raw)["summary"], "Reviewed")
        self.invalid(raw + " ")

    def test_utf8_byte_limit_and_invalid_unicode_refuse_before_json(self):
        with patch.object(pips.json, "loads", side_effect=AssertionError("invalid bytes were parsed")):
            self.assertIn("32000-byte input budget", str(self.invalid("\u20ac" * 10667)))
            self.assertIn("invalid Unicode", str(self.invalid("PRIVATE_UNICODE\ud800")))
        for value in (None, False, [], {}, b'{"summary":"Reviewed","findings":[]}'):
            with self.subTest(value=type(value).__name__):
                self.assertIn("UTF-8 text", str(self.invalid(value)))

    def test_source_inspection_gate_and_evidence_checks_are_not_relaxed(self):
        with patch.object(pips.json, "loads", side_effect=AssertionError("unread report was parsed")), \
             self.assertRaises(RegistryError) as failure:
            self.parse("not-json", read_calls=0)
        self.assertEqual(failure.exception.code, "unverified_report")
        wrong = {"summary": "Reviewed", "findings": [{"title": "Concern", "severity": "low", "path": "source.py",
                  "line": 2, "evidence": "    return 99"}]}
        # Unverified evidence costs its finding (named in limitations), never the report, and is never reported.
        parsed = self.parse(json.dumps(wrong))
        self.assertEqual(parsed["findings"], [])
        self.assertIn("1 'Concern' (source.py, line 2): its quoted code isn't at that line", parsed["limitations"][0])
        with self.assertRaises(RegistryError):
            self.parse('{"summary":"Reviewed","findings":[],"unexpected":"value"}')


if __name__ == "__main__":
    unittest.main()
