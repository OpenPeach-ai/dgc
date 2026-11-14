"""Paying by itself, in dollars (0.52, agreed 13 Nov ~19:10; pips-sandbox-design §5, payments-research.md).

Only at Do it all, and only when the user allowed that Pip to pay (pip_levels.paying):
  1. "Allow payments up to $X a day": the TOTAL of that Pip's payments in the last day; required before it pays by
     itself ("no limit" is possible, never the default).
  2. Optional: at most N payments a day (any number, no maximum).
  3. Optional: only on these sites (a site and its subdomains).
  4. Optional, for all Pips together: up to $Y a day (Settings).
  5. The same site and the same amount twice in a day asks.
The 10 Nov count (3 a day across all Pips, up to 20) is retired.

DGC, never the model, reads the amount and the currency (read_payment) and converts it with a daily reference rate it
reads itself (the ECB's, cached for a day). An amount or currency it can't read for certain, or no rate to hand, asks:
some payments will still ask at Do it all, and that is the honest answer. A Pip never types a card number.
"""
from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from .workspace_registry import RegistryError

LIMITS_KEY = "pip_pay_limits:"            # metadata: {usd_per_day: number|"no_limit"|null, max_count, sites, at, by}
TOTAL_KEY = "pips_pay_total"               # metadata: {usd_per_day: number|null, at, by}
RATES_KEY = "pip_pay_rates"                # metadata: {day, rates: {CUR: per-EUR}}
DAY = timedelta(hours=24)
MAX_USD = Decimal("1000000")
MAX_SITES = 50
LOCAL = ("editor-user", "local-console")
ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_payments_made(
 id TEXT PRIMARY KEY, pip_id TEXT NOT NULL, site TEXT NOT NULL, amount TEXT NOT NULL, currency TEXT NOT NULL,
 usd TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS pip_payments_made_at ON pip_payments_made(at);
"""
_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY"}
_AMOUNT_NAMES = re.compile(r"(?:^|[_\-. ])(?:amount|total|price|sum|amt|grand_?total|pay_?amount)(?:$|[_\-. ])", re.IGNORECASE)
_CURRENCY_NAMES = re.compile(r"(?:^|[_\-. ])(?:currency|curr|ccy|currency_?code)(?:$|[_\-. ])", re.IGNORECASE)
_NUMBER = re.compile(r"^\s*([$€£₹¥])?\s*([0-9]{1,3}(?:[,.\s][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)\s*([A-Za-z]{3})?\s*$")


# ---- the rules the user sets -----------------------------------------------------------------------------------------
def _now_dt():
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read(registry, key):
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
    try:
        value = json.loads(row[0]) if row else None
    except (ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _usd(value):
    if value in (None, "no_limit"):
        return value
    if type(value) not in (int, float) or isinstance(value, bool):
        raise RegistryError("invalid_request", "Set the daily limit in dollars, such as 50, or no_limit.")
    amount = Decimal(str(value))
    if not Decimal("0") < amount <= MAX_USD:
        raise RegistryError("invalid_request", "Set a daily limit above $0, up to $1,000,000.")
    return float(amount)


def limits(registry, pip_id) -> dict:
    saved = _read(registry, LIMITS_KEY + str(pip_id)) or {}
    usd = saved.get("usd_per_day")
    return {"usd_per_day": usd if usd == "no_limit" or (type(usd) in (int, float) and usd > 0) else None,
            "max_count": saved.get("max_count") if type(saved.get("max_count")) is int and saved["max_count"] > 0 else None,
            "sites": [s for s in saved.get("sites") or [] if isinstance(s, str)][:MAX_SITES] or None}


def set_limits(registry, pip_id, changes: dict, actor) -> dict:
    """set_pip_pay_limits: a Pip's daily dollar total (or no_limit), and optionally a count and a site list."""
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you set how much a Pip may pay, on this computer.")
    if not isinstance(changes, dict) or not changes or set(changes) - {"usd_per_day", "max_count", "sites"}:
        raise RegistryError("invalid_request", "Set usd_per_day, and optionally max_count and sites.")
    if registry.db.execute("SELECT 1 FROM pips WHERE id=?", (pip_id,)).fetchone() is None:
        raise RegistryError("not_found", "That Pip isn't on this computer.")
    now = limits(registry, pip_id)
    if "usd_per_day" in changes:
        now["usd_per_day"] = _usd(changes["usd_per_day"])
    if "max_count" in changes:
        count = changes["max_count"]
        if count is not None and (type(count) is not int or count < 1):
            raise RegistryError("invalid_request", "At most how many payments a day: a whole number from 1, or none.")
        now["max_count"] = count
    if "sites" in changes:
        sites = changes["sites"]
        if sites is not None and (not isinstance(sites, list) or len(sites) > MAX_SITES
                                  or not all(isinstance(s, str) and re.fullmatch(r"[a-z0-9.-]{1,253}", s.lower()) for s in sites)):
            raise RegistryError("invalid_request", "List the sites by name, such as shop.example.")
        now["sites"] = sorted({s.lower().strip(".") for s in sites}) if sites else None
    with registry.transaction():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (LIMITS_KEY + pip_id, json.dumps(
            {**now, "at": registry.clock(), "by": actor})))
    return {"pip_id": pip_id, "limits": limits(registry, pip_id), "spent_today": float(spent(registry, pip_id))}


def all_total(registry):
    saved = _read(registry, TOTAL_KEY) or {}
    usd = saved.get("usd_per_day")
    return usd if type(usd) in (int, float) and usd > 0 else None


def set_all_total(registry, usd_per_day, actor) -> dict:
    """set_pips_payments {usd_per_day}: all Pips together, up to this a day; null for none."""
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you set how much your Pips may pay, on this computer.")
    value = _usd(usd_per_day) if usd_per_day is not None else None
    if value == "no_limit":
        value = None
    with registry.transaction():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                            (TOTAL_KEY, json.dumps({"usd_per_day": value, "at": registry.clock(), "by": actor})))
    return payments(registry)


def payments(registry) -> dict:
    """get_pips_payments: {usd_per_day (all Pips together, or null), spent_today (all Pips, in dollars)}."""
    return {"usd_per_day": all_total(registry), "spent_today": float(spent(registry))}


# ---- what it paid ------------------------------------------------------------------------------------------------
def _ensure(db) -> None:
    for statement in (part.strip() for part in SCHEMA.split(";")):
        if statement:
            db.execute(statement)


def _today(registry, pip_id=None) -> list:
    db = registry.db
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_payments_made'").fetchone() is None:
        return []
    since = _iso(_now_dt() - DAY)
    return db.execute("SELECT * FROM pip_payments_made WHERE at>=?" + (" AND pip_id=?" if pip_id else ""),
                      (since, pip_id) if pip_id else (since,)).fetchall()


def spent(registry, pip_id=None) -> Decimal:
    total = Decimal("0")
    for row in _today(registry, pip_id):
        try:
            total += Decimal(row["usd"])
        except InvalidOperation:
            continue
    return total


def record(registry, pip_id, payment: dict, kind: str) -> None:
    """A payment a Pip made by itself, noted before it goes (in the caller's commit or its own)."""
    usd = to_usd(registry, payment["amount"], payment["currency"])
    from contextlib import nullcontext
    with nullcontext() if registry.db.in_transaction else registry.transaction():
        _ensure(registry.db)
        registry.db.execute("INSERT INTO pip_payments_made VALUES(?,?,?,?,?,?,?,?)",
                            ("pay_" + secrets.token_hex(16), pip_id, str(payment.get("site") or "")[:253],
                             str(payment["amount"]), payment["currency"], str(usd if usd is not None else payment["amount"]),
                             kind, _iso(_now_dt())))


# ---- rates (DGC reads them, never the model) ----------------------------------------------------------------------
def _fetch_rates() -> dict:
    """The ECB's daily reference rates: {CUR: units per 1 EUR}. Raises on any failure."""
    import requests
    import xml.etree.ElementTree as ET
    response = requests.get(ECB_URL, timeout=10)
    response.raise_for_status()
    root = ET.fromstring(response.content[:200_000])
    rates = {"EUR": Decimal("1")}
    for node in root.iter():
        if node.get("currency") and node.get("rate"):
            rates[node.get("currency").upper()] = Decimal(node.get("rate"))
    if "USD" not in rates:
        raise ValueError("no dollar rate")
    return rates


def forget_rates(registry) -> None:
    with registry.transaction():
        registry.db.execute("DELETE FROM metadata WHERE key=?", (RATES_KEY,))


def _rates(registry) -> dict | None:
    day = _now_dt().strftime("%Y-%m-%d")
    saved = _read(registry, RATES_KEY)
    if saved and saved.get("day") == day and isinstance(saved.get("rates"), dict):
        return {k: Decimal(v) for k, v in saved["rates"].items()}
    try:
        rates = _fetch_rates()
    except Exception:                                    # noqa: BLE001 - no rate to hand: a payment in it asks
        return None
    try:
        with registry.transaction():
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                                (RATES_KEY, json.dumps({"day": day, "rates": {k: str(v) for k, v in rates.items()}})))
    except Exception:                                    # noqa: BLE001 - kept or not, the rate is good for this payment
        pass
    return rates


def to_usd(registry, amount, currency) -> Decimal | None:
    if not isinstance(amount, Decimal) or not isinstance(currency, str):
        return None
    currency = currency.upper()
    if currency == "USD":
        return amount
    rates = _rates(registry)
    if not rates or currency not in rates or "USD" not in rates or rates[currency] <= 0:
        return None
    return (amount / rates[currency] * rates["USD"]).quantize(Decimal("0.01"))


# ---- reading the amount ---------------------------------------------------------------------------------------------
def _parse(text):
    match = _NUMBER.match(str(text or ""))
    if not match:
        return None, None
    symbol, number, code = match.groups()
    digits = number.replace(" ", "")
    if "," in digits and "." in digits:
        digits = digits.replace(",", "") if digits.rfind(".") > digits.rfind(",") else digits.replace(".", "").replace(",", ".")
    elif "," in digits:
        head, _, tail = digits.rpartition(",")
        digits = head.replace(",", "") + ("." + tail if len(tail) <= 2 else tail)
    try:
        amount = Decimal(digits)
    except InvalidOperation:
        return None, None
    currency = (code.upper() if code else None) or _SYMBOLS.get(symbol or "")
    return amount, currency


def read_payment(fields, site) -> dict | None:
    """{amount, currency, site} when exactly one amount field reads as a number and its currency is certain (from a
    currency field, a symbol or a code beside the number); else None, and the payment asks."""
    pairs = list(fields.items()) if isinstance(fields, dict) else list(fields or [])
    amounts, currencies = [], set()
    for name, value in pairs:
        name = str(name or "")
        if _CURRENCY_NAMES.search(name) and isinstance(value, str) and re.fullmatch(r"[A-Za-z]{3}", value.strip()):
            currencies.add(value.strip().upper())
        elif _AMOUNT_NAMES.search(name):
            amount, currency = _parse(value)
            if amount is None:
                return None
            amounts.append(amount)
            if currency:
                currencies.add(currency)
    if len(amounts) != 1 or len(currencies) != 1 or amounts[0] <= 0:
        return None
    return {"amount": amounts[0], "currency": currencies.pop(), "site": str(site or "").lower()[:253]}


# ---- the decision -------------------------------------------------------------------------------------------------
def _on(site, sites) -> bool:
    site = str(site or "").lower()
    return any(site == s or site.endswith("." + s) for s in sites)


def may_pay(registry, pip_id, payment) -> bool:
    """Whether this Pip may make this payment by itself now. Anything uncertain is False: it asks."""
    from . import pip_levels
    try:
        if pip_levels.paying(registry, pip_id) != pip_levels.ALLOW or pip_levels.effective(registry, pip_id) != pip_levels.FULL:
            return False
        if not isinstance(payment, dict) or not isinstance(payment.get("amount"), Decimal):
            return False
        rules = limits(registry, pip_id)
        if rules["usd_per_day"] is None:
            return False                                 # a daily limit is required before it pays by itself
        usd = to_usd(registry, payment["amount"], payment.get("currency"))
        if usd is None:
            return False
        if rules["sites"] and not _on(payment.get("site"), rules["sites"]):
            return False
        mine = _today(registry, pip_id)
        if rules["max_count"] is not None and len(mine) >= rules["max_count"]:
            return False
        if any(row["site"] == str(payment.get("site") or "").lower() and Decimal(row["amount"]) == payment["amount"]
               and row["currency"] == str(payment.get("currency")).upper() for row in mine):
            return False                                 # the same site and amount twice in a day asks
        if rules["usd_per_day"] != "no_limit" and spent(registry, pip_id) + usd > Decimal(str(rules["usd_per_day"])):
            return False
        total = all_total(registry)
        if total is not None and spent(registry) + usd > Decimal(str(total)):
            return False
        return True
    except Exception:                                    # noqa: BLE001 - unreadable means it asks
        return False
