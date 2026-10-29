"""Large saved daily logs must not be loaded into the Pips page."""
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from dgc import pip_daily_log


class DailyLogBounds(unittest.TestCase):
    def test_large_log_is_left_untouched_and_skipped(self):
        with tempfile.TemporaryDirectory() as temp:
            pip_id = "pip_" + "a" * 32
            folder = Path(temp) / "daily-log" / pip_id
            folder.mkdir(parents=True)
            day = folder / "2026-10-29.md"
            with day.open("wb") as stream:
                stream.truncate(pip_daily_log.MAX_DAY_BYTES + 1)
            pip_daily_log.record(temp, pip_id, "- 12:00 · Task · Done", now=datetime(2026, 10, 29))
            self.assertEqual(day.stat().st_size, pip_daily_log.MAX_DAY_BYTES + 1)
            self.assertEqual(pip_daily_log.days(temp, pip_id)["days"], [])
