"""sdk/PIPS.md names every command the SDK sends, and its gate table has a row for every Pips API from 80 on."""
import re
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "sdk" / "python"))


def doc() -> str:
    return (REPO / "sdk" / "PIPS.md").read_text(encoding="utf-8")


def names(command: str, text: str) -> bool:
    """`command` alone, or `command {fields}` as the gate table writes it."""
    return re.search(r"`" + re.escape(command) + r"[` ]", text) is not None


class EveryCommandIsDocumented(unittest.TestCase):
    def test_every_sdk_command_is_named_in_pips_md(self):
        from dgc_sdk import pips
        text = doc()
        missing = sorted(c for c in pips.READ_COMMANDS | pips.MUTATION_COMMANDS if not names(c, text))
        self.assertEqual(missing, [], "commands the SDK sends that sdk/PIPS.md never names")

    def test_the_gate_table_has_a_row_for_every_api_from_80(self):
        from dgc.headless import PIPS_API_VERSION
        rows = {int(n) for n in re.findall(r"^\| (\d+) \|", doc(), re.M)}
        self.assertEqual(sorted(set(range(80, PIPS_API_VERSION + 1)) - rows), [])

    def test_each_new_gate_row_names_its_commands(self):
        from dgc_sdk import pips
        text = doc()
        for api in range(80, 89):
            row = next((line for line in text.splitlines() if line.startswith(f"| {api} |")), "")
            for name in ("READS", "MUTATIONS"):
                for command in sorted(getattr(pips, f"API{api}_{name}", frozenset())):
                    with self.subTest(api=api, command=command):
                        self.assertTrue(names(command, row), row[:200])

    def test_fields_that_came_with_80_to_88_are_named(self):
        text = doc()
        for field in ("`reply_to`", "`terminal`", "`number`", "`keys`", '`op` `close`', "`group`"):
            with self.subTest(field=field):
                self.assertIn(field, text)

    def test_host_only_copies_say_so(self):
        row = next(line for line in doc().splitlines() if line.startswith("| `copy_pip_computer_file_in` |"))
        self.assertIn("host", row.lower())


if __name__ == "__main__":
    unittest.main()
