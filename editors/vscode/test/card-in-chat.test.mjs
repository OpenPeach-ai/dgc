import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// Card numbers stay out of the chats (three-asks test, 2026-10-20): a Pip's chat refuses one (pip-app-links has
// that), and the Work chat warns once, since whatever is sent there goes to the model. src/pipCards.js and the copy
// in media/main.js find the same numbers as dgc/cards.py: a card, never a bill, UHID, phone or account number.
const here = dirname(fileURLToPath(import.meta.url));
const pipCards = (() => {
  const code = buildSync({ entryPoints: [here + "/../src/pipCards.js"], bundle: true, format: "cjs", write: false, platform: "node" }).outputFiles[0].text;
  const mod = { exports: {} }; new Function("module", "exports", code)(mod, mod.exports); return mod.exports;
})();
const mainCopy = (() => {
  const src = readFileSync(here + "/../media/main.js", "utf8");
  const body = src.slice(src.indexOf("// card-number:start"), src.indexOf("// card-number:end"));
  return new Function(body + "\nreturn cardNumberIn;")();
})();
const CARDS = [["Use my card 4242 4242 4242 4242, expiry 12/34, CVV 123", "4242424242424242"], ["5555-5555-5555-4444", "5555555555554444"],
  ["card 5555-5555-5555-4444 12/34", "5555555555554444"], ["amex 378282246310005", "378282246310005"], ["card 6011111111111117", "6011111111111117"],
  ["jcb 3530111333300000", "3530111333300000"]];
const NOT_CARDS = ["Bill No. SMH/OP/26/118734, UHID SMH0048213, ₹5,350.00", "Invoice CSD-INV-77391, patient ID CS-220914",
  "GSTIN 27AAKCS1234F1Z9", "call me on +91 98000 00000 or 020-4100 2200", "Aadhaar 2345 6789 0123", "HDFC account 50100123456789",
  "4242 4242 4242 4241", "order 1234567890123456", "PNR 4521 8833 90, ticket 0987654321098", "DL No. MH-PZ3-118204"];

test("the Pip chat's check and the Work chat's copy find a card, never a bill, UHID, phone or account number", () => {
  for (const find of [pipCards.cardNumber, mainCopy]) {
    for (const [text, digits] of CARDS) assert.equal(find(text), digits, text);
    for (const text of NOT_CARDS) assert.equal(find(text), null, text);
  }
});

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, page, posted;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  const mainJs = readFileSync(here + "/../media/main.js", "utf8");
  const markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true, format: "iife", globalName: "DgcMarkdown",
    write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0])
    .find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  page = await browser.newPage({ viewport: { width: 460, height: 800 } });
  await page.setContent(skeleton.replace("</head>", `<style>${css}</style></head>`), { waitUntil: "load" });
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    window.postMessage({ type: "session_ready", sessionId: "s1" }, "*");
  }, [mainJs, markdownJs]);
  await page.waitForFunction(() => document.getElementById("input"));
  posted = () => page.evaluate(() => window.__posted.filter(m => m.type === "prompt").map(m => m.text));
});
after(async () => { await browser?.close(); });

test("the Work chat warns once about a card number; Enter again sends it as it is; a bill number just goes", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await page.click("#input");
  await page.keyboard.type("Bill SMH/OP/26/118734, UHID SMH0048213, order 1234567890123456");
  await page.keyboard.press("Enter");
  assert.deepEqual(await posted(), ["Bill SMH/OP/26/118734, UHID SMH0048213, order 1234567890123456"], "no card: sent at once");
  await page.click("#input");
  await page.keyboard.type("Pay it with 4242 4242 4242 4242 12/34");
  await page.keyboard.press("Enter");
  assert.equal((await posted()).length, 1, "a card is not sent on the first Enter");
  assert.match(await page.evaluate(() => document.body.textContent), /That looks like a payment card number\. Whatever you send here goes to the model, so card numbers stay out of the chat\./);
  await page.keyboard.press("Enter");
  assert.deepEqual((await posted()).at(-1), "Pay it with 4242 4242 4242 4242 12/34", "Enter again sends it as it is");
});
