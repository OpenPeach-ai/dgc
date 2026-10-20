"""DGC signs a Pip in with a saved login: it finds the sign-in fields, types the values as real input, and submits.

The Pip asks with its computer's ``sign_in`` step; this runs in the supervisor, on the Pip's own browser (a
``BoxedBrowser``), and the Pip is told only what happened: "filled the username and password", "filled the code",
"no saved login for this site", "the page asked for something else". Never a value.

- **Finding the fields.** Scripts of DGC's own, in an isolated world of the page (the page's scripts can neither see
  them nor change the built-ins they use), read the page as a person would see it: visible, enabled inputs, their
  type, ``autocomplete`` tokens, names, labels and ARIA names. They answer with booleans and mark the fields they
  chose with a nonce; no script ever carries a secret.
- **Typing.** Each field is focused, emptied the way typing over it would (so a React-style form follows), and the
  value goes in with CDP ``Input.insertText`` over the browser's private pipe: real input, never a page script,
  never a command line or a log. A field that gets a password or a code is marked ``data-dgc-secret`` first, so every
  screenshot the Pip is shown blacks it out and ``read`` never shows its value.
- **Submitting.** Enter in the last field, or the form's own sign-in button. That one request is let through by the
  write gate for the login's sign-in hosts only, when it carries a value just typed (``LoginPass``); every other
  submit is held for the user as before.
- **Steps.** Username and password, then a one-time code (made here from the saved key, pip_totp), up to three steps,
  each read back from the page. A site that asks again, a robot check, or a box DGC can't fill ends it, and a
  password still on the page is cleared from it.
"""
from __future__ import annotations

import json
import secrets as _secrets
import socket
import time
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, quote, quote_plus, urlsplit

from .browser import BrowserError

SECRET_MARK = "data-dgc-secret"
MARK = "data-dgc-login"
MAX_STEPS = 3
FILL_BUDGET = 40.0
ENTER_WAIT = 2.0
OUTCOME_WAIT = 8.0
NEXT_STEP_WAIT = 10.0
PASS_SECONDS = 15.0
POLL = 0.25
HOLD_SECONDS = 60.0

_HELPERS = r"""
  const MARK = 'data-dgc-login', SECRET = 'data-dgc-secret', SENT = 'data-dgc-login-sent';
  const visible = (el) => {
    if (!(el instanceof Element) || !el.isConnected || el.getClientRects().length === 0) return false;
    for (let node = el; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  const marked = (prefix) => Array.from(document.querySelectorAll('[' + MARK + ']')).filter((el) => (el.getAttribute(MARK) || '').startsWith(prefix));
  const alertText = () => {
    for (const el of document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"], .error, .alert, [class*="error" i]')) {
      if (!visible(el) || el.querySelector('input, select, textarea')) continue;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && text.length <= 300) return text.slice(0, 200);
    }
    return '';
  };
  const sending = (fields) => {
    const form = fields.map((el) => el.form).find(Boolean);
    const controls = form ? Array.from(form.querySelectorAll('button, input[type=submit], input[type=image]')).filter((el) => el.type === 'submit' || el.type === 'image') : [];
    return Boolean(document.querySelector('[aria-busy="true"]')) || controls.some((el) => el.disabled);
  };
  const humanCheck = () => Array.from(document.querySelectorAll('iframe')).some((frame) => {
    const src = frame.getAttribute('src') || '';
    if (!/recaptcha|hcaptcha|challenges\.cloudflare\.com|arkoselabs|funcaptcha/i.test(src) || /size=invisible|checkbox-invisible/i.test(src)) return false;
    const box = frame.getBoundingClientRect();
    return visible(frame) && box.width > 100 && box.height > 60;
  });
  const labelOf = (el) => [el.name, el.id, el.getAttribute('aria-label'), el.placeholder, el.getAttribute('autocomplete'),
    ...Array.from(el.labels || []).map((l) => l.textContent || ''), el.getAttribute('aria-labelledby') ? (document.getElementById(el.getAttribute('aria-labelledby')) || {}).textContent || '' : ''].join(' ').toLowerCase();
"""

# Marks this step's username, password and one-time-code boxes "<nonce>:<step>:<name>".
FIND = r"""function (nonce, step) {""" + _HELPERS + r"""
  const key = nonce + ':' + step + ':';
  for (const old of document.querySelectorAll('[' + MARK + ']')) {
    const owner = old.getAttribute(MARK) || '';
    if (!owner.startsWith(nonce + ':') || owner.startsWith(key)) old.removeAttribute(MARK);
  }
  const usable = (el) => el instanceof HTMLInputElement && !el.disabled && !el.readOnly && el.type !== 'hidden' && visible(el);
  const tokens = (el) => (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  const plain = (el) => el.type === 'text' || el.type === 'email' || el.type === 'tel';
  const STRONG = /(?:^|[^a-z])t?otp|2fa|mfa|two[-_ ]?factor|one[-_ ]?time|authenticator/;
  const WEAK = /verif|security[-_ ]?code|auth\w*[-_ ]?code|passcode|\bcode\b/;
  const NOT_CODE = /zip|postal|promo|coupon|country|area|invite|referr|cvv|cvc|csc|card|gift/;
  const card = (el) => tokens(el).some((t) => t.startsWith('cc-'));
  const isCode = (el) => !card(el) && (tokens(el).includes('one-time-code') ||
    ((plain(el) || el.type === 'number' || el.type === 'password') && STRONG.test(labelOf(el)) && !NOT_CODE.test(labelOf(el))) ||
    ((plain(el) || el.type === 'number') && WEAK.test(labelOf(el)) && !NOT_CODE.test(labelOf(el))));
  const inputs = Array.from(document.querySelectorAll('input')).filter(usable);
  const codes = inputs.filter(isCode);
  const rest = inputs.filter((el) => !codes.includes(el) && !card(el));
  const passwords = rest.filter((el) => el.type === 'password' && !tokens(el).includes('new-password'));
  const password = passwords.find((el) => tokens(el).includes('current-password')) || passwords[0] || null;
  const USER = /user|e-?mail|login|account|identifier|phone|mobile|customer|member/;
  const userLike = (el) => tokens(el).includes('username') || tokens(el).includes('email') || el.type === 'email' || (plain(el) && USER.test(labelOf(el)));
  let username = null;
  if (password) {
    const scope = rest.filter((el) => el !== password && plain(el) && (password.form ? el.form === password.form : !el.form));
    const before = scope.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    username = before.filter(userLike).pop() || before.pop() || scope.find(userLike) || null;
  } else {
    username = rest.find((el) => tokens(el).includes('username')) || rest.find((el) => plain(el) && userLike(el)) || null;
  }
  let boxes = [];
  if (codes.length) {
    const first = codes[0];
    const near = (el) => el.parentElement === first.parentElement || (el.parentElement && first.parentElement && el.parentElement.parentElement === first.parentElement.parentElement);
    const group = first.maxLength === 1 ? inputs.filter((el) => el.maxLength === 1 && near(el)) : [];
    boxes = group.length >= 4 ? group : [first];
  }
  if (username) username.setAttribute(MARK, key + 'username');
  if (password) password.setAttribute(MARK, key + 'password');
  boxes.forEach((el, index) => el.setAttribute(MARK, key + 'code' + index));
  const other = inputs.filter((el) => el !== username && el !== password && !boxes.includes(el) && !card(el) && (plain(el) || el.type === 'password' || el.type === 'number')).length;
  return {href: location.href, title: document.title, username: Boolean(username), password: Boolean(password),
          code: boxes.length, other: other, human: humanCheck(), alert: alertText()};
}"""

# "type" empties the field the way typing over it would; a password or code box is marked secret first. "submit"
# only focuses it, and listens (on the page's document, which every world shares) for the form being sent.
FOCUS = r"""function (nonce, key, mode, keep) {""" + _HELPERS + r"""
  const el = document.querySelector('[' + MARK + '="' + key + '"]');
  if (!(el instanceof HTMLInputElement)) return {href: location.href, focused: false, same: false};
  if (mode === 'type' && typeof keep === 'string' && keep && el.value === keep) return {href: location.href, focused: true, same: true};
  if (mode === 'type' && /:(?:password|code\d+)$/.test(key)) el.setAttribute(SECRET, '1');
  if (mode === 'submit' && document.documentElement.getAttribute(SENT + '-watch') !== nonce) {
    document.documentElement.setAttribute(SENT + '-watch', nonce);
    addEventListener('submit', () => document.documentElement.setAttribute(SENT, nonce + ':submitted'), true);
    addEventListener('beforeunload', () => document.documentElement.setAttribute(SENT, nonce + ':leaving'), true);
  }
  try { el.scrollIntoView({block: 'center'}); } catch (e) {}
  el.focus();
  if (mode === 'type' && el.value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', {bubbles: true}));
  }
  const busy = mode === 'submit' && sending(marked(nonce + ':').filter((f) => f instanceof HTMLInputElement));
  return {href: location.href, focused: document.activeElement === el, same: false, busy: busy};
}"""

CHECK = r"""function (key) {""" + _HELPERS + r"""
  const out = {};
  for (const el of marked(key)) out[(el.getAttribute(MARK) || '').slice(key.length)] = typeof el.value === 'string' && el.value.length > 0;
  return out;
}"""

# The form's own submit button first, else a button named for signing in anywhere on the page: its centre.
SUBMIT_AT = r"""function (key) {""" + _HELPERS + r"""
  const fields = marked(key).filter((el) => el instanceof HTMLInputElement);
  const field = fields.find((el) => /:password$/.test(el.getAttribute(MARK) || '')) || fields[fields.length - 1];
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();
  const NAMED = /^(?:sign ?in|log ?in|log ?on|sign ?on|continue|next|submit|verify|confirm)$/i;
  const enabled = (el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const inForm = field && field.form
    ? Array.from(field.form.querySelectorAll('button, input[type=submit], input[type=image]')).filter((el) => enabled(el) && (el.type === 'submit' || el.type === 'image'))
    : [];
  const control = inForm.find((el) => NAMED.test(label(el))) || inForm[0] ||
    Array.from(document.querySelectorAll('button, [role="button"], input[type=submit], input[type=button]')).find((el) => enabled(el) && NAMED.test(label(el)));
  if (!control) return {found: false};
  try { control.scrollIntoView({block: 'center'}); } catch (e) {}
  const r = control.getBoundingClientRect();
  return {found: r.width > 0 && r.height > 0, x: r.left + r.width / 2, y: r.top + r.height / 2};
}"""

STATE = r"""function (nonce) {""" + _HELPERS + r"""
  const ours = marked(nonce + ':').filter((el) => el instanceof HTMLInputElement);
  const sent = document.documentElement.getAttribute(SENT) || '';
  return {href: location.href, title: document.title, present: ours.some(visible), busy: sending(ours),
          submitted: sent === nonce + ':submitted', leaving: sent === nonce + ':leaving', alert: alertText(), human: humanCheck()};
}"""

CLEAR = r"""function (nonce) {""" + _HELPERS + r"""
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  let cleared = 0;
  for (const el of document.querySelectorAll('[' + SECRET + ']')) {
    if (!(el instanceof HTMLInputElement) || !el.value) continue;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    cleared++;
  }
  return {href: location.href, cleared: cleared};
}"""

UNMARK = r"""function (nonce) {""" + _HELPERS + r"""
  for (const el of marked(nonce + ':')) el.removeAttribute(MARK);
  return {href: location.href};
}"""

# Is this a sign-in page? (For the line DGC adds to the Pip's read, and for the card it shows.)
SIGN_IN_PAGE = r"""function () {""" + _HELPERS + r"""
  const inputs = Array.from(document.querySelectorAll('input')).filter((el) => !el.disabled && el.type !== 'hidden' && visible(el));
  const password = inputs.some((el) => el.type === 'password' && !(el.getAttribute('autocomplete') || '').includes('new-password'));
  const user = inputs.some((el) => /(^|\s)(username|email)(\s|$)/.test(el.getAttribute('autocomplete') || '') || el.type === 'email');
  return {href: location.href, password: password, user: user};
}"""


# --------------------------------------------------------------------------- what the Pip is told

MASK = "\u2022\u2022\u2022\u2022\u2022\u2022"
CODE_SECONDS = 300
MIN_SECRET = 4


def secret_forms(value: str) -> set[str]:
    """A secret as a page or a request may show it: as typed, JSON-escaped, HTML-escaped, URL-encoded."""
    import html
    forms = {value, json.dumps(value)[1:-1], html.escape(value, quote=True), quote_plus(value, safe=""),
             quote(value, safe="")}
    return {f for f in forms if len(f) >= MIN_SECRET}


class Scrubber:
    """Saved secrets, the passwords typed on this computer and its recent one-time codes, masked in every answer the
    computer gives the Pip (and in what it records for the user). A screenshot can't be scrubbed: it is masked."""

    def __init__(self, stored=None, now=time.monotonic):
        self.stored = stored or (lambda: ())
        self.now = now
        self.filled: set[str] = set()
        self.codes: dict[str, float] = {}

    def remember(self, value: str, kind: str) -> None:
        if not isinstance(value, str) or not value:
            return
        if kind == "code":
            self.codes[value] = self.now() + CODE_SECONDS
        elif len(value) >= MIN_SECRET and len(self.filled) < 500:
            self.filled.add(value)

    def scrub(self, text):
        if not isinstance(text, str) or not text:
            return text
        try:
            stored = tuple(self.stored())
        except Exception:                                 # noqa: BLE001 -- the filled ones are still masked
            stored = ()
        forms = sorted({form for value in (*stored, *self.filled) if isinstance(value, str) and len(value) >= MIN_SECRET
                        for form in secret_forms(value)}, key=len, reverse=True)
        for form in forms:
            if form in text:
                text = text.replace(form, MASK)
        if self.codes:
            import re
            moment = self.now()
            for code, until in list(self.codes.items()):
                if until <= moment:
                    del self.codes[code]
                elif code in text:
                    text = re.sub(r"(?<!\d)" + re.escape(code) + r"(?!\d)", MASK, text)
        return text


# --------------------------------------------------------------------------- the write gate's one exception

def _forms(value: str) -> set[str]:
    forms = {value, json.dumps(value)[1:-1], quote_plus(value, safe=""), quote(value, safe="")}
    return {f for f in forms if f}


@dataclass
class LoginPass:
    """The one submit a saved login authorises: to the login's sign-in hosts (or its site), soon, once, carrying a
    value DGC just typed. Anything else the page sends is held as before."""
    hosts: frozenset
    site: str
    exact: bool
    values: tuple
    until: float
    sent: list = field(default_factory=list)

    def admits(self, url: str, post: str, content_type: str) -> bool:
        from .pip_logins import site_of
        if time.monotonic() > self.until or not post:
            return False
        host = (urlsplit(str(url or "")).hostname or "").lower().rstrip(".")
        if not host or not (host in self.hosts or (not self.exact and site_of(host) == self.site)):
            return False
        from .pip_computer_box import carries_card_number
        if carries_card_number(post):
            return False
        return carries_value(post, content_type, self.values)


def carries_value(post: str, content_type: str, values) -> bool:
    """Whether a request body carries one of these values, as a form, JSON or plain text sends it."""
    wanted = {v for v in values if v}
    if not wanted:
        return False
    text = post or ""
    if "json" in (content_type or ""):
        try:
            found = json.loads(text)
        except ValueError:
            found = None
        stack = [found]
        while stack:
            item = stack.pop()
            if isinstance(item, str) and item in wanted:
                return True
            if isinstance(item, dict):
                stack.extend(item.values())
            elif isinstance(item, list):
                stack.extend(item)
    if "=" in text and "\n" not in text[:4000]:
        if any(value in wanted for _, value in parse_qsl(text, keep_blank_values=True)):
            return True
    return any(form in text for value in wanted for form in _forms(value))


# --------------------------------------------------------------------------- one sign-in

FIELD_WORDS = {"username": "the username", "password": "the password", "code": "the one-time code"}


def _join(words):
    words = list(words)
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1] if words else ""


def page_address(href: str) -> str:
    """Where a page is, without its query or fragment (sign-in pages carry codes and tokens there)."""
    parts = urlsplit(str(href or ""))
    return f"{parts.scheme}://{parts.netloc}{parts.path}" if parts.scheme and parts.netloc else "the next page"


@dataclass
class Outcome:
    ok: bool
    text: str
    filled: list = field(default_factory=list)
    signed_in: bool = False
    held: dict | None = None            # {url}: a filled secret may still be on that page
    asked_else: bool = False


class SignIn:
    """One sign_in on one saved login: each step fills what the page shows and submits it, then reads what the page
    did. ``remember(value, kind)`` hands each secret to the computer's scrubber before it is typed."""

    def __init__(self, browser, login: dict, *, remember, now=None, wall=None, sleep=None):
        from .pip_logins import site_of
        self.browser, self.login, self.remember = browser, login, remember
        self.now = now or (lambda: time.monotonic())
        self.wall = wall or (lambda: time.time())
        self.sleep = sleep or (lambda seconds: time.sleep(seconds))
        now = self.now
        self.nonce = _secrets.token_hex(12)
        self.deadline = now() + FILL_BUDGET
        self.done: list[str] = []
        self.secret_url = ""
        self.site = login["site"]
        self.hosts = frozenset(login["hosts"])
        self.exact = bool(login.get("exact"))
        self._site_of = site_of

    # -- the page ----------------------------------------------------------------------------

    def _page(self, function: str, *args):
        try:
            value = self.browser._in_world(self.browser._isolated(), function, *args)
        except (BrowserError, socket.timeout, OSError, KeyError, TypeError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def still_here(self, href: str) -> bool:
        from .pip_logins import page_check
        ok, host, _ = page_check(href)
        return ok and (host in self.hosts or (not self.exact and self._site_of(host) == self.site))

    def words(self) -> str:
        return _join(FIELD_WORDS[f] for f in self.done)

    def clear(self) -> None:
        self._page(CLEAR, self.nonce)
        self._page(UNMARK, self.nonce)

    def outcome(self, ok: bool, text: str, *, signed_in: bool = False, asked_else: bool = False) -> Outcome:
        held = {"url": self.secret_url} if self.secret_url and not signed_in and ok else None
        return Outcome(ok, text, list(self.done), signed_in, held, asked_else)

    def failed(self, text: str) -> Outcome:
        self.clear()
        self.secret_url = ""
        return self.outcome(False, text + " The password was cleared from the page.")

    def _find(self, step: int, wait: float) -> dict | None:
        until = min(self.deadline, self.now() + wait)
        while True:
            fields = self._page(FIND, self.nonce, step)
            ready = fields and (fields["password"] or fields["code"] or fields["human"] or not self.still_here(fields["href"]))
            if ready or self.now() >= until:
                return fields
            self.browser.pump(POLL)

    # -- the steps ---------------------------------------------------------------------------

    def run(self) -> Outcome:
        try:
            return self._steps()
        except Exception:
            self.clear()
            raise
        finally:
            self.browser.login_pass = None

    def _steps(self) -> Outcome:
        fields = self._find(0, 0)
        for step in range(MAX_STEPS + 1):
            if not fields:
                if step == 0:
                    return self.outcome(False, "The browser didn't answer. Read the page, then use sign_in again.")
                return self._signed_in("", "")
            if not self.still_here(fields["href"]):
                if step == 0:
                    return self.outcome(False, f"This page isn't on {self.site}, where the saved login is used.")
                return self._signed_in(fields["href"], fields.get("title", ""))
            if (fields["password"] and "password" in self.done) or (fields["code"] and "code" in self.done):
                said = f" It said: “{fields['alert']}”." if fields.get("alert") else ""
                return self.failed(f"The site did not accept the saved login for {self.site}: it asked for it again, and "
                                   f"nothing was sent twice.{said} Tell the user in one sentence that the saved login may be "
                                   "out of date; they can change it on your page, under Logins.")
            if step > 0 and not fields["password"] and not fields["code"]:
                if fields["human"]:
                    return self.outcome(True, f"Filled {self.words()} and sent it, and the site now shows a robot check. "
                                        "Stop and ask the user to finish it on your screen (Open its computer).", asked_else=True)
                if "password" not in self.done:
                    return self.outcome(True, f"Filled {self.words()} and sent it, but no password box followed. Read the "
                                        "page, then use sign_in again once it shows one.")
                return self._signed_in(fields["href"], fields.get("title", ""))
            if step >= MAX_STEPS:
                return self._signed_in(fields["href"], fields.get("title", ""))
            typed = self._fill(step, fields)
            if typed is None:
                self._page(UNMARK, self.nonce)
                if fields["code"] and not self.login.get("totp"):
                    return self.outcome(bool(self.done), (f"Filled {self.words()} and sent it. " if self.done else "")
                                        + f"The page asks for a one-time code, and the login saved for {self.site} has no "
                                        "authenticator key. Stop and ask the user to type the code on your screen "
                                        "(Open its computer).", asked_else=True)
                if not fields["username"] and not fields["password"] and not fields["code"]:
                    return self.outcome(False, f"No sign-in boxes on this page. Open {self.site}'s sign-in page (the one "
                                        "with the username or password box), then use sign_in again.")
                return self.outcome(False, "The page didn't take the typing. Click into its sign-in box once, then use "
                                    "sign_in again, or ask the user to sign in on your screen.", asked_else=True)
            if fields["human"]:
                self.secret_url = fields["href"]
                return self.outcome(True, f"Filled {self.words()}, but it was not sent: the page shows a robot check. Stop "
                                    "and ask the user to finish it and press the sign-in button on your screen.", asked_else=True)
            sent = self._submit(step, typed, fields.get("alert", ""))
            if sent is None:
                self.secret_url = fields["href"]
                return self.outcome(True, f"Filled {self.words()}, but the page has no sign-in button DGC could press. Ask "
                                    "the user to press it on your screen.")
            if sent.get("human"):
                return self.failed(f"A robot check appeared on {self.site} after the login was sent. Ask the user to "
                                   "finish signing in on your screen (Open its computer).")
            if not sent["changed"]:
                said = f" It said: “{sent['alert']}”." if sent.get("alert") else " The page didn't change."
                return self.failed(f"The site did not accept the saved login for {self.site}.{said} Tell the user in one "
                                   "sentence; they can change the login on your page, under Logins.")
            self.secret_url = ""
            wait = NEXT_STEP_WAIT if "password" not in self.done else (5.0 if self.login.get("totp") and "code" not in self.done else 1.5)
            fields = self._find(step + 1, wait)
        return self._signed_in(fields["href"] if fields else "", fields.get("title", "") if fields else "")

    def _signed_in(self, href: str, title: str) -> Outcome:
        self._page(UNMARK, self.nonce)
        where = f" The page is now {page_address(href)}" + (f" (“{' '.join(str(title).split())[:120]}”)" if title else "") + "." if href else ""
        return self.outcome(True, f"Signed in to {self.site}: DGC filled {self.words()} and sent it.{where} Read the page "
                            "to check. You never see the saved login; never ask the user for a password or a code.",
                            signed_in=True)

    def _type(self, key: str, text: str, keep: str | None = None) -> str:
        focus = self._page(FOCUS, self.nonce, key, "type", keep)
        if not focus or not isinstance(focus.get("href"), str) or not self.still_here(focus["href"]):
            return "moved"
        if focus.get("same"):
            return "kept"
        if not focus.get("focused"):
            return "missed"
        self.browser.insert_text(text)
        return "typed"

    def _fill(self, step: int, fields: dict):
        key = f"{self.nonce}:{step}:"
        typed: list[tuple[str, str]] = []
        values: list[str] = []
        moved = False

        def fill(name, text, keep=None):
            nonlocal moved
            if moved:
                return False
            result = self._type(key + name, text, keep)
            moved = result == "moved"
            return result in ("typed", "kept")

        username = self.login["username"]
        if fields["username"] and username and fill("username", username, username):
            typed.append(("username", "username"))
            values.append(username)
        if fields["password"] and not moved:
            password = self.login["password"]
            self.remember(password, "password")
            if fill("password", password):
                typed.append(("password", "password"))
                values.append(password)
        totp = self.login.get("totp")
        if fields["code"] and totp and not moved:
            from . import pip_totp
            self.remember(totp["secret"], "password")
            left = pip_totp.seconds_left(totp, self.wall())
            if left < 3.0:
                self.sleep(left + 0.3)           # never a code about to change
            code = pip_totp.code(totp, self.wall())
            self.remember(code, "code")
            boxes = 1 if fields["code"] == 1 else min(fields["code"], len(code))
            last = ""
            for index in range(boxes):
                if fill(f"code{index}", code if boxes == 1 else code[index]):
                    last = f"code{index}"
            if last:
                typed.append(("code", last))
                values.append(code)
        checked = self._page(CHECK, key) or {}
        held = [(name, last) for name, last in typed if checked.get("code0" if name == "code" else name) is True]
        if not held:
            return None
        for name, _ in held:
            if name not in self.done:
                self.done.append(name)
        if any(name != "username" for name, _ in held):
            self.secret_url = fields["href"]
        self._values = tuple(values)
        return held[-1][1]

    def _submit(self, step: int, last: str, alert_before: str):
        """Enter in the step's last field; when that sends nothing within two seconds, the form's sign-in button. The
        write gate lets that one request through (LoginPass). Returns {changed, href, title, alert, human} or None."""
        key = f"{self.nonce}:{step}:"
        focus = self._page(FOCUS, self.nonce, key + last, "submit", None) or {}
        before = str(focus.get("href") or "")
        busy_before = focus.get("busy") is True
        self.browser.login_pass = LoginPass(self.hosts, self.site, self.exact, getattr(self, "_values", ()),
                                            self.now() + PASS_SECONDS)

        def moved(state):
            return state["href"].split("#", 1)[0] != before.split("#", 1)[0] or not state["present"] or state["leaving"]

        def settled(state):
            return state == "silent" or moved(state) or state["human"] or (state["alert"] and state["alert"] != alert_before)

        def watch(seconds, until_sent):
            end = min(self.deadline, self.now() + seconds)
            state = None
            while True:
                self.browser.pump(POLL)
                state = self._page(STATE, self.nonce)
                if state and (settled(state) or (until_sent and (state["submitted"] or (state["busy"] and not busy_before)))):
                    return state
                if self.now() >= end:
                    return state or "silent"

        self.browser.press("enter")
        state = watch(ENTER_WAIT, True)
        if not settled(state) and not (state != "silent" and (state["submitted"] or state["busy"])):
            spot = self._page(SUBMIT_AT, key) or {}
            if not spot.get("found"):
                return None
            self.browser.click_at(float(spot["x"]), float(spot["y"]))
        if not settled(state):
            state = watch(OUTCOME_WAIT, False)
        if state == "silent":
            return {"changed": True, "href": before, "title": "", "alert": "", "human": False}
        fresh = state["alert"] if state["alert"] and state["alert"] != alert_before else ""
        return {"changed": moved(state), "href": state["href"], "title": state["title"], "alert": fresh,
                "human": not moved(state) and state["human"]}


def sign_in_page(browser) -> dict | None:
    """{href, password, user} for the page now (a sign-in page has a password box, or a username or email box)."""
    try:
        value = browser._in_world(browser._isolated(), SIGN_IN_PAGE)
    except (BrowserError, socket.timeout, OSError, KeyError, TypeError, ValueError):
        return None
    return value if isinstance(value, dict) and isinstance(value.get("href"), str) else None


def clear_secrets(browser) -> int:
    """Empty every box DGC typed a password or code into that is still on the page (the hold's end)."""
    try:
        value = browser._in_world(browser._isolated(), CLEAR, "")
    except (BrowserError, socket.timeout, OSError, KeyError, TypeError, ValueError):
        return 0
    return int(value.get("cleared") or 0) if isinstance(value, dict) else 0
