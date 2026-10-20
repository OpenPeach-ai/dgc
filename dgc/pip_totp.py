"""One-time codes for saved logins (RFC 6238 TOTP over RFC 4226 HOTP), made on this computer.

A login saved for a Pip may carry the site's authenticator key, as a base32 secret or an ``otpauth://totp/...``
link (what a QR code holds). DGC makes the code when it signs the Pip in: SHA1, SHA256 or SHA512, 6 to 8 digits,
a 10 to 300 second period. Counter-based keys (``otpauth://hotp/``) are refused: a code that moves on each use
can't be shared with the user's own authenticator app. The key is never shown back; a login only says it has one.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import struct
import time
from urllib.parse import parse_qs, unquote, urlsplit

ALGORITHMS = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}
_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
MAX_KEY_TEXT = 2048


class TotpError(ValueError):
    """A key DGC can't use, in words the save form shows. Never carries the key."""


def decode_base32(text: str) -> bytes | None:
    """RFC 4648 base32, any case; spaces, dashes and padding ignored. None when it isn't base32."""
    clean = re.sub(r"[\s-]", "", str(text or "")).rstrip("=").upper()
    if not clean or any(ch not in _BASE32 for ch in clean):
        return None
    bits = buffer = 0
    out = bytearray()
    for ch in clean:
        buffer = (buffer << 5) | _BASE32.index(ch)
        bits += 5
        if bits >= 8:
            bits -= 8
            out.append((buffer >> bits) & 0xFF)
    return bytes(out)


def parse_key(raw) -> dict:
    """{secret, algorithm, digits, period} from a base32 secret or an otpauth://totp link. Raises TotpError."""
    if not isinstance(raw, str):
        raise TotpError("Paste the authenticator key, or leave it empty.")
    text = raw.strip()
    if not text or len(text) > MAX_KEY_TEXT:
        raise TotpError("That authenticator key is empty or too long.")
    secret, algorithm, digits, period = text, "SHA1", 6, 30
    if text.lower().startswith("otpauth:"):
        parts = urlsplit(text)
        kind = (parts.netloc or parts.path.lstrip("/").split("/", 1)[0]).lower()
        if kind == "hotp":
            raise TotpError("That is a counter-based key (HOTP). DGC takes time-based keys (TOTP), the kind most "
                            "authenticator apps show.")
        if kind != "totp":
            raise TotpError("That otpauth link isn't a time-based (TOTP) key.")
        query = {k.lower(): v[-1] for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
        secret = unquote(query.get("secret", ""))
        algorithm = query.get("algorithm", "SHA1").upper().replace("-", "")
        try:
            digits = int(query.get("digits", "6"))
            period = int(query.get("period", "30"))
        except ValueError:
            raise TotpError("That otpauth link has a period or a number of digits that isn't a whole number.") from None
    if algorithm not in ALGORITHMS:
        raise TotpError("DGC makes codes with SHA1, SHA256 or SHA512 only.")
    if not 6 <= digits <= 8:
        raise TotpError("A code has 6 to 8 digits.")
    if not 10 <= period <= 300:
        raise TotpError("A code lasts 10 to 300 seconds.")
    key = decode_base32(secret)
    if key is None or len(key) < 10:
        raise TotpError("That isn't an authenticator key: it should be letters A-Z and digits 2-7, at least 16 of them, "
                        "or an otpauth:// link.")
    return {"secret": re.sub(r"[\s-]", "", secret).rstrip("=").upper(), "algorithm": algorithm,
            "digits": digits, "period": period}


def valid_key(value) -> bool:
    """A stored key's shape (the sealed file is checked on every read)."""
    return (isinstance(value, dict) and set(value) == {"secret", "algorithm", "digits", "period"}
            and isinstance(value["secret"], str) and re.fullmatch(r"[A-Z2-7]{16,}", value["secret"]) is not None
            and value["algorithm"] in ALGORITHMS and type(value["digits"]) is int and 6 <= value["digits"] <= 8
            and type(value["period"]) is int and 10 <= value["period"] <= 300)


def hotp(key: bytes, counter: int, digits: int = 6, algorithm: str = "SHA1") -> str:
    """RFC 4226: HMAC of the counter, dynamically truncated."""
    mac = hmac.new(key, struct.pack(">Q", counter), ALGORITHMS[algorithm]).digest()
    offset = mac[-1] & 0x0F
    binary = struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(binary % (10 ** digits)).zfill(digits)


def code(key: dict, now: float | None = None) -> str:
    """The code a key shows at ``now`` (seconds since the epoch; RFC 6238, T0 = 0)."""
    raw = decode_base32(key["secret"])
    if raw is None:
        raise TotpError("The saved authenticator key is not valid.")
    moment = time.time() if now is None else float(now)
    return hotp(raw, int(moment // key["period"]), key["digits"], key["algorithm"])


def seconds_left(key: dict, now: float | None = None) -> float:
    """How long the current code has left."""
    moment = time.time() if now is None else float(now)
    return key["period"] - (moment % key["period"])
