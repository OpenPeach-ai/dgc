"""Paying by itself, in dollars (0.52, agreed 13 Nov ~19:10; pips-sandbox-design §5, payments-research.md).

Per Pip, only at Do it all: "Allow payments up to $X a day" is the TOTAL of its payments that day, and it is required
before it pays by itself. Optional per Pip: at most N payments a day (any number, no maximum) and only on these sites.
Optional for all Pips together: up to $Y a day. DGC asks when a Pip pays the same site the same amount twice in a day.
The 10 Nov count (3 a day across all Pips, up to 20) is retired. DGC, never the model, reads the amount and converts it
with a daily reference rate it reads itself; an amount or currency it can't read for certain, or no rate to hand, asks.

Real registry, real Pips and levels, the real control seam; the rate source stood in.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from dgc import pip_levels as levels, pip_payments as pay, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests.test_pips_local import config as pips_config

RATES = {"USD": Decimal("1.08"), "INR": Decimal("90.0"), "GBP": Decimal("0.85")}     # per 1 EUR, as the ECB says them


class Paying(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-pay-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        env = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home")})
        env.start()
        self.addCleanup(env.stop)
        self.registry = WorkspaceRegistry(self.base / "pips")
        self.addCleanup(self.registry.close)
        self.store = pips.PipStore(self.registry)
        self.cfg = pips_config(self.base)
        rates = patch.object(pay, "_fetch_rates", return_value=dict(RATES))
        rates.start()
        self.addCleanup(rates.stop)
        self.pip = self.allowed("Bills")

    def allowed(self, name):
        pip = self.store.create(self.registry.personal()["id"], name, None, "editor-user", pip_type="quill")
        with self.registry.transaction():
            levels.start(self.registry, pip["id"])
        levels.set_level(self.registry, pip["id"], levels.FULL, "editor-user")
        levels.set_paying(self.registry, pip["id"], levels.ALLOW, "editor-user")
        return pip

    def payment(self, amount="20.00", currency="USD", site="shop.example"):
        return {"amount": Decimal(amount), "currency": currency, "site": site}

    def limit(self, pip=None, **changes):
        return pay.set_limits(self.registry, (pip or self.pip)["id"], changes, "editor-user")

    def paid(self, pip=None, **kwargs):
        pay.record(self.registry, (pip or self.pip)["id"], self.payment(**kwargs), "computer")


class TheDailyTotal(Paying):
    def test_a_daily_dollar_limit_is_required_before_it_pays_by_itself(self):
        self.assertFalse(pay.may_pay(self.registry, self.pip["id"], self.payment()))
        self.limit(usd_per_day=50)
        self.assertTrue(pay.may_pay(self.registry, self.pip["id"], self.payment()))

    def test_the_limit_is_the_total_of_its_payments_that_day(self):
        self.limit(usd_per_day=50)
        self.paid(amount="40.00")
        self.assertFalse(pay.may_pay(self.registry, self.pip["id"], self.payment(amount="20.00")), "40 + 20 > 50")
        self.assertTrue(pay.may_pay(self.registry, self.pip["id"], self.payment(amount="9.99", site="other.example")))

    def test_another_currency_is_converted_with_dgcs_own_rate_and_no_rate_asks(self):
        self.limit(usd_per_day=50)
        self.assertTrue(pay.may_pay(self.registry, self.pip["id"], self.payment(amount="3000", currency="INR")),
                        "₹3000 is about $36")
        self.assertFalse(pay.may_pay(self.registry, self.pip["id"], self.payment(amount="6000", currency="INR")))
        self.assertFalse(pay.may_pay(self.registry, self.pip["id"], self.payment(currency="XYZ")), "no rate: it asks")
        with patch.object(pay, "_fetch_rates", side_effect=OSError("offline")):
            pay.forget_rates(self.registry)
            self.assertFalse(pay.may_pay(self.registry, self.pip["id"], self.payment(currency="GBP")), "offline: it asks")
            self.assertTrue(pay.may_pay(self.registry, self.pip["id"], self.payment(currency="USD")),
                            "dollars need no rate")

    def test_an_amount_dgc_cant_read_asks(self):
        self.limit(usd_per_day=50)
        self.assertFalse(pay.may_pay(self.registry, self.pip["id"], None))
        self.assertFalse(pay.may_pay(self.registry, self.pip["id"], {"amount": None, "currency": "USD", "site": "a.example"}))

    def test_only_at_do_it_all_and_only_when_you_allowed_it(self):
        self.limit(usd_per_day=50)
        levels.set_level(self.registry, self.pip["id"], levels.APPROVE, "editor-user")
        self.assertFalse(pay.may_pay(self.registry, self.pip["id"], self.payment()))

    def test_no_limit_is_possible_but_never_the_default(self):
        self.assertIsNone(pay.limits(self.registry, self.pip["id"])["usd_per_day"])
        self.limit(usd_per_day="no_limit")
        self.assertTrue(pay.may_pay(self.registry, self.pip["id"], self.payment(amount="5000")))


class TheOptionalRules(Paying):
    def test_at_most_n_payments_a_day_any_number(self):
        self.limit(usd_per_day=500, max_count=1)
        self.paid(amount="5.00", site="a.example")
        self.assertFalse(pay.may_pay(self.registry, self.pip["id"], self.payment(amount="5.00", site="b.example")))
        self.limit(usd_per_day=500, max_count=200)
        self.assertTrue(pay.may_pay(self.registry, self.pip["id"], self.payment(amount="5.00", site="b.example")))

    def test_only_on_these_sites(self):
        self.limit(usd_per_day=500, sites=["shop.example"])
        self.assertTrue(pay.may_pay(self.registry, self.pip["id"], self.payment(site="shop.example")))
        self.assertTrue(pay.may_pay(self.registry, self.pip["id"], self.payment(site="pay.shop.example")), "its subdomains")
        self.assertFalse(pay.may_pay(self.registry, self.pip["id"], self.payment(site="evil.example")))

    def test_all_pips_together_up_to_a_daily_total(self):
        other = self.allowed("Groceries")
        self.limit(usd_per_day=100)
        self.limit(other, usd_per_day=100)
        pay.set_all_total(self.registry, 30, "editor-user")
        self.paid(amount="25.00")
        self.assertFalse(pay.may_pay(self.registry, other["id"], self.payment(amount="10.00", site="b.example")),
                         "25 + 10 > 30 across all Pips")
        pay.set_all_total(self.registry, None, "editor-user")
        self.assertTrue(pay.may_pay(self.registry, other["id"], self.payment(amount="10.00", site="b.example")))

    def test_the_same_site_and_amount_twice_in_a_day_asks(self):
        self.limit(usd_per_day=500)
        self.paid(amount="12.50", site="shop.example")
        self.assertFalse(pay.may_pay(self.registry, self.pip["id"], self.payment(amount="12.50", site="shop.example")))
        self.assertTrue(pay.may_pay(self.registry, self.pip["id"], self.payment(amount="12.51", site="shop.example")))


class ReadingTheAmount(unittest.TestCase):
    def test_an_amount_and_its_currency_from_a_form_or_an_inputs_object(self):
        self.assertEqual(pay.read_payment([("billno", "SMH/1"), ("amount", "5350.00"), ("currency", "INR")], "pay.example"),
                         {"amount": Decimal("5350.00"), "currency": "INR", "site": "pay.example"})
        self.assertEqual(pay.read_payment({"total": "$12.50"}, "shop.example")["currency"], "USD")
        self.assertEqual(pay.read_payment({"price": "€9,99"}, "shop.example"),
                         {"amount": Decimal("9.99"), "currency": "EUR", "site": "shop.example"})

    def test_anything_uncertain_is_none(self):
        self.assertIsNone(pay.read_payment([("amount", "10"), ("total", "12")], "a.example"), "two amounts")
        self.assertIsNone(pay.read_payment([("amount", "10")], "a.example"), "no currency")
        self.assertIsNone(pay.read_payment([("amount", "ten"), ("currency", "USD")], "a.example"))
        self.assertIsNone(pay.read_payment([("note", "hello")], "a.example"))


class TheCommands(Paying):
    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_set_pip_pay_limits_and_set_pips_payments_are_yours_alone(self):
        result = self.control({"type": "set_pip_pay_limits", "pip_id": self.pip["id"], "usd_per_day": 40,
                               "max_count": None, "sites": ["shop.example"]})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["result"]["limits"]["usd_per_day"], 40)
        refused = self.control({"type": "set_pip_pay_limits", "pip_id": self.pip["id"], "usd_per_day": 40}, "device_1")
        self.assertEqual(refused["error"]["code"], "local_only")
        total = self.control({"type": "set_pips_payments", "usd_per_day": 75})
        self.assertEqual(total["result"]["payments"]["usd_per_day"], 75)
        self.assertNotIn("limit", total["result"]["payments"], "the old count is retired")
        bad = self.control({"type": "set_pip_pay_limits", "pip_id": self.pip["id"], "usd_per_day": -5})
        self.assertFalse(bad["ok"])


if __name__ == "__main__":
    unittest.main()
