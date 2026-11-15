// A Pip's held-step cards in its chat (pip-chat-scene.mjs opens it), one per kind: a new site with a long name, a form,
// a payment, an order, what it read from your apps going to a site or into its Terminal, and the command that could
// delete everything in its Files. Shared by pip-cards-always-browser.test.mjs, the narrowest-words walk and the
// pictures. Not a *.test.mjs file.
import { openChat } from "./pip-chat-scene.mjs";

export const HOLDS = {
  // Finding 45: the site's name is one long word.
  site: { kind: "site", site: "quantobra.pt", shown: "www.quantobra.pt", method: "GET", host: "www.quantobra.pt", path: "/precos/2026" },
  longSite: { kind: "site", site: "precos-construcao-civil-portugal.example.com", shown: "www.precos-construcao-civil-portugal.example.com", method: "GET", host: "www.precos-construcao-civil-portugal.example.com", path: "/" },
  form: { method: "POST", host: "news.example", path: "/account/alerts", page: "https://news.example/account", route: "/account/alerts", fields: [{ name: "email", value: "me@mail.example" }], body_bytes: 30 },
  payment: { method: "POST", host: "shop.example", path: "/checkout/pay", page: "https://shop.example/checkout", route: "/checkout/pay", payment: true, asks_because: "payment", fields: [{ name: "amount", value: "42.00" }], body_bytes: 40 },
  order: { method: "POST", host: "shop.example", path: "/items/42", page: "https://shop.example/items/42", route: "/items/*", asks_because: "maybe_payment", asks_word: "order", fields: [{ name: "item", value: "tee" }], body_bytes: 9 },
  carry: { kind: "text", read_from_apps: true, method: "TYPE", host: "quantobra.pt", path: "/contact", page: "https://quantobra.pt/contact", fields: [{ name: "typed", value: "Order 118734, 40 m² of porcelain" }], text: "Order 118734, 40 m² of porcelain" },
  terminal: { kind: "text", read_from_apps: true, method: "RUN", host: "Terminal", path: "/", fields: [{ name: "command", value: "python cart.py --sku LT-204" }], text: "python cart.py --sku LT-204" },
  floor: { kind: "floor", floor: "could delete everything in its Files", method: "RUN", host: "Terminal", path: "/", fields: [{ name: "command", value: "rm -rf ~/Files" }] },
};

/** Opens a Pip's chat with one held step's card waiting. kind: a key of HOLDS; the rest is pip-chat-scene's openChat. */
export const openCard = (browser, kind, options = {}) => openChat(browser, { hold: HOLDS[kind], height: 720, ...options });

/** The waiting card as drawn: its title and line, each button (words, box, shape), the quiet limit line, and what is cut. */
export const cardNow = (p) => p.evaluate(() => {
  const root = window.__pipsRoot || document, card = root.querySelector("[data-computer-card]"); if (!card) return null;
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const lines = (n) => { const range = document.createRange(); range.selectNodeContents(n); const tops = []; for (const r of range.getClientRects()) if (r.width > 0.5 && !tops.some((t) => Math.abs(t - r.top) < r.height / 2)) tops.push(r.top); return tops.length; };
  const buttons = [...card.querySelectorAll(".dgc-card-actions button")].map((b) => { const s = getComputedStyle(b); return { text: b.textContent.trim(), label: b.getAttribute("aria-label") || "", title: b.title, ...box(b), radius: parseFloat(s.borderTopLeftRadius), cls: b.className, cut: b.scrollWidth > b.clientWidth + 1, lines: lines(b),
    border: s.borderTopColor, ground: s.backgroundColor, font: `${s.fontWeight} ${s.fontSize}`, always: b.hasAttribute("data-computer-always") }; });
  const limit = card.querySelector(".allow-limit"), actions = card.querySelector(".dgc-card-actions");
  const domains = [...card.querySelectorAll(".card-domain")].map((d) => ({ text: d.textContent, title: d.title, lines: lines(d), cut: d.scrollWidth > d.clientWidth + 1, dots: getComputedStyle(d).textOverflow, ...box(d) }));
  return { title: card.querySelector("strong").textContent, small: card.querySelector(".dgc-card-words small")?.textContent || "", card: box(card), actions: box(actions), buttons, domains,
    limit: limit ? { text: limit.textContent, ...box(limit), lines: lines(limit), color: getComputedStyle(limit).color, size: parseFloat(getComputedStyle(limit).fontSize) } : null,
    sideways: document.documentElement.scrollWidth > innerWidth || (root.querySelector(".pip-app-root")?.scrollWidth || 0) > (root.querySelector(".pip-app-root")?.clientWidth || 0) + 1 };
});
