"""SDK usage reports summarize a long log without trusting damaged rows."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk" / "python"))
from dgc_sdk.usage import UsageLog, _count  # noqa: E402


class UsageLogLimitsTests(unittest.TestCase):
    def test_long_log_keeps_full_totals_and_only_last_500_rows(self):
        with tempfile.TemporaryDirectory(prefix="dgc-sdk-usage-") as temporary:
            log = UsageLog(Path(temporary) / "state")
            lines = [json.dumps({"ts": i + 1, "id": i, "department": "a" if i % 2 == 0 else "b",
                                 "input_tokens": 1, "output_tokens": 2, "cost_usd": .01})
                     for i in range(1200)]
            lines += [json.dumps({"ts": "broken", "input_tokens": 99999, "output_tokens": 99999}),
                      json.dumps({"ts": 1201, "input_tokens": 99999, "output_tokens": 99999,
                                  "padding": "x" * (1024 * 1024)}),
                      json.dumps({"ts": 1202, "id": "unknown", "department": "a",
                                  "input_tokens": None, "output_tokens": None})]
            log.path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            report = log.query()
            self.assertEqual((report["runs"], report["unknown_usage_runs"]), (1201, 1))
            self.assertEqual((report["input_tokens"], report["output_tokens"], report["cost_usd"]),
                             (1200, 2400, 12.0))
            self.assertEqual((len(report["rows"]), report["rows"][0]["id"], report["rows"][-1]["id"]),
                             (500, 701, "unknown"))
            self.assertEqual([item["runs"] for item in report["by_department"]], [601, 600])
            self.assertEqual(log.query(department="b")["runs"], 600)

    def test_nonfinite_count_is_unknown(self):
        self.assertIsNone(_count(float("inf")))


if __name__ == "__main__":
    unittest.main()
