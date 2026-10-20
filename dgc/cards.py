"""Payment card numbers in what a user types to a chat.

A card number typed into a Pip's chat was kept in its history and sent to a cloud model (three-asks test,
2026-10-20). Cards follow the password rule instead: the user types them on the Pip's own screen, never in a chat.
``card_number`` finds one: 13 to 19 digits (spaces or dashes between them allowed) that pass the Luhn check, with a
card network's start and length (Visa, Mastercard, Amex, RuPay...). A bill or UHID number, a phone number, a bank
account number, or a long number that fails the check is not one. The editors check the same way before sending
(pipCards.js); this is the enforcement."""
from __future__ import annotations

import re

_RUN = re.compile(r"\d+(?:[ -]\d+)*")


def _luhn(digits: str) -> bool:
    total, double = 0, False
    for ch in reversed(digits):
        n = int(ch) * (2 if double else 1)
        total += n - 9 if n > 9 else n
        double = not double
    return total % 10 == 0


def _network(digits: str) -> bool:
    """Starts and is as long as a card network's numbers are (Visa, Mastercard, Amex, Diners, Discover, JCB,
    RuPay, Maestro). A 14-digit bank account number that happens to pass Luhn ("50100123456789") is not one."""
    n, two, three, four = len(digits), int(digits[:2]), int(digits[:3]), int(digits[:4])
    return ((digits[0] == "4" and n in (13, 16, 19))
            or ((51 <= two <= 55 or 2221 <= four <= 2720) and n == 16)
            or (two in (34, 37) and n == 15)
            or ((two in (36, 38, 39) or 300 <= three <= 305) and 14 <= n <= 19)
            or ((four == 6011 or two == 65 or 644 <= three <= 649) and 16 <= n <= 19)
            or ((two in (60, 81, 82) or three in (353, 356, 508)) and n == 16)
            or (3528 <= four <= 3589 and 16 <= n <= 19)
            or ((56 <= two <= 58 or two in (62, 63, 67)) and 16 <= n <= 19))


def card_number(text) -> str | None:
    """The first payment card number in ``text`` (its digits only), or None. Digits may be grouped with spaces or
    dashes, one kind of separator per number; "5555-5555-5555-4444 12/34" is the card and its expiry."""
    for match in _RUN.finditer(str(text or "")[:100_000]):
        parts = re.split(r"([ -])", match.group(0))
        groups, seps = parts[0::2], parts[1::2]
        for start in range(min(len(groups), 64)):
            digits, used = "", set()
            for end in range(start, len(groups)):
                if end > start:
                    used.add(seps[end - 1])
                digits += groups[end]
                if len(digits) > 19 or len(used) > 1:
                    break
                if 13 <= len(digits) and _network(digits) and _luhn(digits):
                    return digits
    return None


def refusal(pip_name: str) -> str:
    """What DGC says instead of sending a message with a card number to a Pip."""
    name = " ".join(str(pip_name or "this Pip").split())[:80] or "this Pip"
    return f"Card numbers stay out of the chat. Type it on {name}'s screen instead: open its computer."
