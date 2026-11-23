// Your Browser, phase 4 (0.52): what a Pip's own tab in your browser asks you, in its chat. Two cards of its own: a site it
// may use there only once you allow it ("Let Ava use lanestore.com in Your Browser?": Allow, Not now), and a sign-in only
// you make, in your own tab ("Sign in to lanestore.com in Your Browser?": Open Your Browser, I've signed in, Not now).
// Neither has Always allow; nor has a payment, an order or anything sent on a bank or payment site there: those ask every
// time. What a lane holds is shown in the chat, never among its own computer's notifications.
import { test } from "node:test";
import assert from "node:assert/strict";

const careful = await import("../src/pipCareful.js");

const SITE = { kind: "yb_site", site: "lanestore.com", shown: "lanestore.com", host: "shop.lanestore.com", method: "GET", path: "/", page: "https://shop.lanestore.com/", fields: [], more_fields: 0, body_bytes: 0, your_browser: true };
const SIGN_IN = { ...SITE, kind: "yb_sign_in", page: "https://shop.lanestore.com/account" };
const PAY = { method: "POST", host: "shop.lanestore.com", path: "/checkout/pay", page: "https://shop.lanestore.com/", fields: [], more_fields: 0, body_bytes: 30, payment: true, your_browser: true };
const BANK = { ...PAY, payment: undefined, host: "www.northwind-bank.com", path: "/prefs", asks_because: "money_site" };
const CART = { ...PAY, payment: undefined, path: "/cart" };

test("a site it may use in Your Browser asks once you allow it, by name, with no Always allow", () => {
  const [title, line, yes] = careful.carefulWords(SITE, "Ava");
  assert.equal(title, "Let Ava use lanestore.com in Your Browser?");
  assert.match(line, /its own tab of Your Browser/);
  assert.equal(yes, "Allow");
  assert.deepEqual(careful.heldRequestAnswers(SITE, "Ava").map((b) => [b.how, b.label]), [["send", "Allow"], ["reject", "Not now"]]);
  assert.equal(careful.offersAlways(SITE), false);
  assert.deepEqual(careful.settledWords({ summary: SITE, status: "approved", resolved_by: "editor-user" }), ["Allowed", "Use lanestore.com in Your Browser"]);
  assert.deepEqual(careful.settledWords({ summary: SITE, status: "rejected", resolved_by: "editor-user" }), ["Not now", "Use lanestore.com in Your Browser"]);
});

test("a sign-in is yours: Open Your Browser first, then you say you signed in; the Pip never sees or types it", () => {
  const [title, line] = careful.carefulWords(SIGN_IN, "Ava");
  assert.equal(title, "Sign in to lanestore.com in Your Browser?");
  assert.match(line, /never sees or types your password/);
  assert.deepEqual(careful.heldRequestAnswers(SIGN_IN, "Ava").map((b) => [b.how, b.label]),
    [["yb_open", "Open Your Browser"], ["send", "I’ve signed in"], ["reject", "Not now"]]);
  assert.equal(careful.offersAlways(SIGN_IN), false);
  assert.deepEqual(careful.settledWords({ summary: SIGN_IN, status: "approved", resolved_by: "editor-user" }), ["Signed in", "Sign in to lanestore.com in Your Browser"]);
});

test("in Your Browser a payment, an order or a bank's write asks every time; an ordinary submit may be always allowed", () => {
  assert.equal(careful.offersAlways(PAY), false, "a payment there");
  assert.deepEqual(careful.heldRequestAnswers(PAY, "Ava").map((b) => b.how), ["review", "reject"], "its card: Review…, Reject");
  assert.deepEqual(careful.heldRequestAnswers({ ...PAY, your_browser: undefined }, "Ava").map((b) => b.how), ["review", "always", "reject"]);
  assert.equal(careful.offersAlways({ ...CART, asks_because: "maybe_payment", asks_word: "order" }), false, "an order there");
  assert.equal(careful.offersAlways(BANK), false, "a bank's write there");
  assert.equal(careful.asksWords(BANK), "On a bank or payment site in Your Browser, DGC asks every time.");
  assert.equal(careful.offersAlways(CART), true, "an ordinary submit there, as on its own computer");
  assert.equal(careful.offersAlways({ ...PAY, your_browser: undefined }), true, "its own computer's payment keeps its Always allow (inside its daily limit)");
});

test("what Your Browser asks is known as its own, never its computer's", () => {
  for (const s of [SITE, SIGN_IN, PAY, BANK]) assert.equal(careful.isYourBrowser(s), true);
  assert.equal(careful.isYourBrowser({ ...PAY, your_browser: undefined }), false);
  assert.equal(careful.isYourBrowser({ kind: "site", site: "news.example" }), false);
});
