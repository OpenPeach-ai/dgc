// A link's preview card, the host's half (src/linkPreview.ts; the page's is media/shared/linkpreview.js). A preview
// reads a page because someone pointed at a link, so what it may read is the whole of the feature: only public http(s)
// hosts (by name, by address, and by the address the name resolves to), never a one-time link, never an address that
// carries a secret, only the head of the page, a picture read here and handed over as a data: URI, a cache, and a
// setting. No test here reaches the network: names resolve to stand-in public addresses, dialled on this machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "dgc-linkpreview-host-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const settings = { linkPreviews: true };
globalThis.__DGC_LP_VSCODE = { workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback) }) } };
after(() => { delete globalThis.__DGC_LP_VSCODE; });
const bundle = join(scratch, "linkPreview.cjs");
await build({ entryPoints: [here + "../src/linkPreview.ts"], bundle: true, format: "cjs", platform: "node", outfile: bundle, logLevel: "silent",
  plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "t" })); b.onLoad({ filter: /.*/, namespace: "t" }, () => ({ contents: "module.exports = globalThis.__DGC_LP_VSCODE;", loader: "js" })); } }] });
const lp = createRequire(import.meta.url)(bundle);

// ---- what is never read -------------------------------------------------------------------------------------------
test("only public hosts: a private, local, LAN or tailnet name or address is never read", () => {
  const priv = ["http://localhost:3000/", "http://LOCALHOST/", "http://intranet/wiki", "http://gb10/", "http://printer.local/", "http://nas.lan/", "http://box.home/",
    "http://erp.internal/", "http://x.intranet/", "http://hr.corp/", "http://a.private/", "http://router.home.arpa/", "https://gpu-box.tail1234.ts.net/app", "http://app.localhost/",
    "http://127.0.0.1:8080/", "http://127.9.9.9/", "http://10.0.0.5/", "http://172.16.0.1/", "http://172.31.255.254/", "http://192.168.1.1/admin", "http://100.64.0.1/", "http://100.100.50.2/",
    "http://100.127.255.254/", "http://169.254.169.254/latest/meta-data/", "http://0.0.0.0/", "http://2130706433/", "http://0x7f.1/", "http://017700000001/", "http://224.0.0.1/", "http://255.255.255.255/",
    "http://198.18.0.1/", "http://192.0.2.7/", "http://[::1]/", "http://[::]/", "http://[fe80::1]/", "http://[fd7a:115c:a1e0::1]/", "http://[fc00::1]/", "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:7f00:1]/", "http://[64:ff9b::a00:1]/", "http://[ff02::1]/", "http://[2001:db8::1]/"];
  for (const url of priv) assert.equal(lp.whyNotRead(url), "private", url);
  const pub = ["https://openrouter.ai", "https://github.com/openai/codex", "http://example.com/a/b?page=2", "http://8.8.8.8/", "https://172.32.0.1/", "https://100.128.0.1/", "http://[2606:4700::1111]/",
    "https://sub.domain.example.co.uk/path", "https://news.ycombinator.com/item?id=1"];
  for (const url of pub) assert.equal(lp.whyNotRead(url), "", url);
  for (const url of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "not a url", "", "https://"]) assert.equal(lp.whyNotRead(url), "not-web", url);
});

test("an address, as a name resolves to it: every private range, both families", () => {
  const priv = ["127.0.0.1", "10.1.2.3", "172.16.5.4", "172.31.0.1", "192.168.0.10", "100.64.0.1", "100.127.0.1", "169.254.1.1", "0.0.0.0", "0.1.2.3", "192.0.0.1", "192.0.2.1", "198.18.5.5", "198.51.100.1",
    "203.0.113.9", "224.0.0.251", "240.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "febf::1", "fc00::1", "fd00::1", "fd7a:115c:a1e0::53", "fec0::1", "ff02::fb", "::ffff:192.168.1.1", "::ffff:c0a8:101",
    "64:ff9b::7f00:1", "2001:db8::1", "2002:0a00:0001::1", "not-an-address", ""];
  for (const ip of priv) assert.equal(lp.isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1", "192.169.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "2002:0808:0808::1"]) assert.equal(lp.isPrivateAddress(ip), false, ip);
});

test("no one-time links: an address that carries a token or an action is never read", () => {
  const once = ["https://example.com/reset?token=abc", "https://example.com/cb?code=4%2FP7q", "https://example.com/x?api_key=1", "https://example.com/x?KEY=1", "https://example.com/dl?signature=ab12",
    "https://example.com/dl?sig=ab12", "https://example.com/a?auth=1", "https://example.com/a?session=9", "https://example.com/a?otp=123456", "https://example.com/magic/abc", "https://example.com/reset/abc",
    "https://example.com/verify?e=a", "https://example.com/confirm/12", "https://lists.example.com/unsubscribe/88", "https://example.com/invite/xyz", "https://example.com/login", "https://example.com/users/signin",
    "https://example.com/account/password", "https://example.com/#access_token=abc", "https://example.com/?id_token=abc", "https://bucket.s3.amazonaws.com/f.png?X-Amz-Signature=ab&X-Amz-Expires=60",
    "https://example.com/reset-password", "https://example.com/verify-email/1", "https://example.com/magic-link", "https://example.com/login.php", "https://example.com/a?reset_token=1",
    "https://example.com/a?auth_code=1", "https://example.com/s/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b", "https://example.com/share/dGhpcyBpcyBhIHZlcnkgbG9uZyB0b2tlbg",
    "https://example.com/x?v=ZXlKaGJHY2lPaUpJVXpJMU5pSjk0aWxsYQ", "https://example.com/d/550e8400-e29b-41d4-a716-446655440000", "https://example.com/Login", "https://example.com/a?Token=1",
    "https://example.com/oauth/authorize?client_id=1&state=x&code=y"];
  for (const url of once) assert.equal(lp.whyNotRead(url), "one-time", url);
  const plain = ["https://openrouter.ai", "https://github.com/openai/codex", "https://github.com/openai/codex/blob/main/README.md", "https://example.com/blog/how-to-build-a-link-preview-card-in-2026",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://news.ycombinator.com/item?id=41234567", "https://example.com/docs/authentication/overview", "https://example.com/search?q=reset+my+router&page=2",
    "https://en.wikipedia.org/wiki/Session_(computer_science)", "https://example.com/products/keyboard", "https://example.com/blog/code-review-tips", "https://example.com/a/tokenizers",
    "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy", "https://example.com/2026/11/22/a-long-article-title-with-many-words-in-it.html"];
  for (const url of plain) assert.equal(lp.whyNotRead(url), "", url);
});

test("the outbound guard: an address that carries a secret is never read", () => {
  const known = ["Zx81-spectrum-plus", "hunter2hunter2"];
  const secret = ["https://user:hunter3@example.com/", "https://example.com/p/sk-proj-abcdefghijkl0123", "https://example.com/a?x=ghp_abcdefghijkl0123", "https://example.com/Zx81-spectrum-plus/page",
    "https://example.com/?q=hunter2hunter2", "https://example.com/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM", "https://example.com/a?x=AKIAABCDEFGHIJKLMNOP",
    "https://example.com/hook/xoxb-123456789012-abcdef"];
  for (const url of secret) assert.equal(lp.whyNotRead(url, known), "secret", url);
  assert.equal(lp.carriesSecret("https://example.com/plain/page", known), false);
  assert.equal(lp.carriesSecret("https://example.com/plain/page", ["short"]), false, "a value under 8 characters is no secret to match");
  // A project's .env, read the way DGC reads one: names that say so, values that look like one, a URL's password.
  const values = lp.envSecrets("# a comment\nPORT=8080\nMODE=dev\nAPI_KEY=abcd1234efgh\nexport DB_PW='correct horse battery'\nSALT=9f86d081884c7d659a2f\nDATABASE_URL=postgres://app:s3cretpw9@db/x\nMODEL=deepseek-v4.1-flash:cloud\nSITE=https://example.com\n");
  assert.deepEqual(values.sort(), ["9f86d081884c7d659a2f", "abcd1234efgh", "correct horse battery", "postgres://app:s3cretpw9@db/x", "s3cretpw9"].sort());
});

// ---- reading the head -----------------------------------------------------------------------------------------------
const PAGES = {
  repo: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><link rel="dns-prefetch" href="https://assets.example-cdn.com">
    <title>acme/rocket: Rockets for everyone &middot; Acme Hub</title>
    <meta name="description" content="Rockets for everyone. Contribute to acme/rocket development by creating an account.">
    <meta property="og:image" content="https://cards.example-cdn.com/9f86d081884c7d659a2feaa0c55ad015/acme/rocket" /><meta property="og:image:alt" content="Rockets" />
    <meta property="og:site_name" content="Acme Hub" /><meta property="og:type" content="object" /><meta property="og:title" content="acme/rocket: Rockets for everyone" />
    <meta property="og:url" content="https://hub.example.com/acme/rocket" /><meta property="og:description" content="Rockets for everyone. Contribute to acme/rocket development." />
    <link rel="mask-icon" href="/pinned.svg" color="#000000"><link rel="alternate icon" class="js-site-favicon" type="image/png" href="/favicons/favicon.png">
    <link rel="icon" class="js-site-favicon" type="image/svg+xml" href="/favicons/favicon.svg" data-base-href="/favicons/favicon"></head><body><h1>x</h1></body></html>`,
  twitterOnly: `<html><head><title>Fallback title</title><meta name='twitter:title' content='The future is multi-model'><meta name="twitter:description" content="One interface for every model.">
    <meta name="twitter:image" content="/og.png"><link rel="shortcut icon" href="favicon.ico"></head></html>`,
  reversed: `<head><meta content="Order doesn&#39;t matter &amp; entities &quot;decode&quot; &#x2014; fine" property="og:title"><meta content=unquoted name=description>
    <META PROPERTY="OG:IMAGE" CONTENT="//img.example.org/a.jpg"><link href="/i.png" rel="icon" sizes="32x32"></head>`,
  bare: `<html><head><title>
      Just a   title
    </title></head><body>hello</body></html>`,
  nothing: `<html><head><meta name="viewport" content="width=device-width"></head><body></body></html>`,
  hostile: `<head><title>&lt;img src=x onerror=alert(1)&gt;</title><meta property="og:description" content="a\u0000b‮c  d"><meta property="og:image" content="javascript:alert(1)">
    <link rel="icon" href="data:image/png;base64,AAAA"><script>var x = '<meta property="og:title" content="from a script">';</script><!-- <meta property="og:title" content="from a comment"> --></head>`,
};
test("the head's words: og, then twitter, then <title> and the description, as pages really write them", () => {
  assert.deepEqual(lp.parseHead(PAGES.repo, "https://hub.example.com/acme/rocket"), { title: "acme/rocket: Rockets for everyone", description: "Rockets for everyone. Contribute to acme/rocket development.",
    site: "Acme Hub", image: "https://cards.example-cdn.com/9f86d081884c7d659a2feaa0c55ad015/acme/rocket", icon: "https://hub.example.com/favicons/favicon.png" });
  assert.deepEqual(lp.parseHead(PAGES.twitterOnly, "https://openrouter.example/docs/"), { title: "The future is multi-model", description: "One interface for every model.", site: "",
    image: "https://openrouter.example/og.png", icon: "https://openrouter.example/docs/favicon.ico" });
  assert.deepEqual(lp.parseHead(PAGES.reversed, "https://example.org/x"), { title: "Order doesn't matter & entities \"decode\" — fine", description: "unquoted", site: "",
    image: "https://img.example.org/a.jpg", icon: "https://example.org/i.png" });
  assert.deepEqual(lp.parseHead(PAGES.bare, "https://example.org/"), { title: "Just a title", description: "", site: "", image: "", icon: "" });
  assert.deepEqual(lp.parseHead(PAGES.nothing, "https://example.org/"), { title: "", description: "", site: "", image: "", icon: "" });
  // Words only, never markup; nothing from a script or a comment; a picture or an icon only from http(s).
  assert.deepEqual(lp.parseHead(PAGES.hostile, "https://example.org/"), { title: "<img src=x onerror=alert(1)>", description: "abc d", site: "", image: "", icon: "" });
  const long = lp.parseHead(`<head><title>${"t".repeat(900)}</title><meta name="description" content="${"d ".repeat(900)}"></head>`, "https://example.org/");
  assert.ok(long.title.length <= 200 && long.description.length <= 400, "bounded words");
});

// ---- the whole of it, against stand-in sites on this machine --------------------------------------------------------
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const sites = new Map();          // name -> { port, addresses, hits: [{ method, url, headers }], handler }
const servers = [];
async function site(name, handler, addresses = [{ address: "93.184.216.34", family: 4 }]) {
  const entry = { addresses, hits: [], handler, sockets: new Set(), sent: 0 };
  const server = http.createServer((req, res) => { entry.hits.push({ method: req.method, url: req.url, headers: req.headers }); entry.handler(req, res, entry); });
  server.on("connection", (s) => { entry.sockets.add(s); s.on("close", () => entry.sockets.delete(s)); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  entry.port = server.address().port; servers.push(server); sites.set(name, entry);
  return entry;
}
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
const world = (more = {}) => ({
  enabled: () => settings.linkPreviews !== false,
  resolve: async (name) => { const s = sites.get(name); if (!s) throw new Error("ENOTFOUND"); return s.addresses; },
  dial: (address, port, name) => ({ address: "127.0.0.1", port: sites.get(name)?.port ?? 1 }),
  secrets: () => [],
  ...more,
});
const html = (res, body, type = "text/html; charset=utf-8") => { res.writeHead(200, { "Content-Type": type }); res.end(body); };
const OG = (more = "") => `<!doctype html><html><head><title>Plain title</title><meta property="og:title" content="OpenRouter"><meta property="og:description" content="The unified interface for every model.">
  <meta property="og:site_name" content="OpenRouter">${more}</head><body>${"<p>body</p>".repeat(50)}</body></html>`;

before(async () => {
  await site("pub.test", (req, res) => {
    if (req.url === "/og.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(PNG); return; }
    if (req.url === "/icon.png") { res.writeHead(200, { "Content-Type": "image/png", "Set-Cookie": "a=b" }); res.end(PNG); return; }
    html(res, OG(`<meta property="og:image" content="/og.png"><link rel="icon" href="/icon.png">`));
  });
});

test("a public page: its title, description and site, its picture and icon read here and handed over as data: URIs", async () => {
  const previews = lp.createLinkPreviews(world());
  const got = await previews.preview("http://pub.test/models?tab=new#top");
  assert.equal(got.state, "page");
  assert.equal(got.site, "pub.test");
  assert.equal(got.title, "OpenRouter");
  assert.equal(got.description, "The unified interface for every model.");
  assert.equal(got.image, `data:image/png;base64,${PNG.toString("base64")}`);
  assert.equal(got.icon, `data:image/png;base64,${PNG.toString("base64")}`);
  const hits = sites.get("pub.test").hits.splice(0);
  assert.deepEqual([hits[0].method, hits[0].url], ["GET", "/models?tab=new"], "the page first, never its fragment");
  assert.deepEqual(hits.slice(1).map((h) => [h.method, h.url]).sort(), [["GET", "/icon.png"], ["GET", "/og.png"]], "then its picture and its icon: GET each, once");
  hits.sort((a, b) => ["/models?tab=new", "/og.png", "/icon.png"].indexOf(a.url) - ["/models?tab=new", "/og.png", "/icon.png"].indexOf(b.url));
  for (const hit of hits) {
    assert.equal(hit.headers.cookie, undefined, "no cookies");
    assert.equal(hit.headers.authorization, undefined, "no sign-in");
    assert.equal(hit.headers.referer, undefined, "no referrer");
    assert.equal(hit.headers.host, "pub.test", "asked by its own name");
    assert.match(hit.headers["user-agent"], /^Mozilla\/5\.0 \(compatible; DGC link preview\)$/, "a plain reader's name");
  }
  assert.match(hits[0].headers.accept, /^text\/html/);
  assert.match(hits[1].headers.accept, /^image\//);
  // What went out is kept, newest last: the site and how much came back, never the address's path.
  const sent = previews.sent();
  assert.deepEqual(sent.map((s) => [s.host, s.kind]).sort(), [["pub.test", "icon"], ["pub.test", "page"], ["pub.test", "picture"]]);
  assert.equal(sent[0].kind, "page");
  assert.ok(sent.every((s) => typeof s.at === "number" && typeof s.received_bytes === "number" && !("url" in s)));
});

test("a private or one-time link, or one with a secret, is answered with its address alone and nothing is asked", async () => {
  const asked = [];
  const previews = lp.createLinkPreviews(world({ resolve: async (name) => { asked.push(name); return [{ address: "93.184.216.34", family: 4 }]; }, secrets: () => ["Zx81-spectrum-plus"] }));
  for (const [url, why, site] of [["http://localhost:3000/app", "private", "localhost:3000"], ["https://gpu-box.tail1234.ts.net/x", "private", "gpu-box.tail1234.ts.net"], ["http://192.168.1.10/", "private", "192.168.1.10"],
    ["https://pub.test/reset?token=abc", "one-time", "pub.test"], ["https://pub.test/Zx81-spectrum-plus", "secret", "pub.test"]]) {
    const got = await previews.preview(url);
    assert.deepEqual([got.state, got.why, got.site], ["address", why, site], url);
    assert.equal(got.title, undefined); assert.equal(got.image, undefined);
  }
  assert.deepEqual(asked, [], "not even its name was looked up");
  assert.deepEqual(previews.sent(), []);
  assert.deepEqual(sites.get("pub.test").hits, []);
});

test("a name that resolves to a private address is refused before anything connects (and so is one address among several)", async () => {
  let dialled = 0;
  const inside = await site("rebind.test", (req, res) => html(res, OG()), [{ address: "10.0.0.7", family: 4 }]);
  const mixed = await site("mixed.test", (req, res) => html(res, OG()), [{ address: "93.184.216.34", family: 4 }, { address: "fd7a:115c:a1e0::5", family: 6 }]);
  const previews = lp.createLinkPreviews(world({ dial: (a, p, name) => { dialled++; return { address: "127.0.0.1", port: sites.get(name).port }; } }));
  for (const url of ["http://rebind.test/", "http://mixed.test/"]) {
    const got = await previews.preview(url);
    assert.deepEqual([got.state, got.why], ["address", "private"], url);
  }
  assert.equal(dialled, 0);
  assert.deepEqual([inside.hits.length, mixed.hits.length], [0, 0]);
  // With nothing standing in, the address a name gives is the one connected to: this machine's own is refused.
  const real = lp.createLinkPreviews({ enabled: () => true, secrets: () => [], resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
  assert.deepEqual((({ state, why }) => [state, why])(await real.preview(`http://looks-public.example:${inside.port}/`)), ["address", "private"]);
  assert.equal(inside.hits.length, 0);
});

test("a redirect to a private host is never followed, and at most three are", async () => {
  const hidden = await site("hidden.test", (req, res) => html(res, OG()), [{ address: "192.168.1.20", family: 4 }]);
  await site("hop.test", (req, res) => {
    const to = { "/to-private-name": "http://hidden.test/admin", "/to-private-address": `http://127.0.0.1:${hidden.port}/admin`, "/to-localhost": "http://localhost/admin", "/to-file": "file:///etc/passwd",
      "/1": "/2", "/2": "/3", "/3": "/page", "/a": "/b", "/b": "/c", "/c": "/d", "/d": "/page", "/to-https-private": "https://10.0.0.1/" }[req.url];
    if (to) { res.writeHead(302, { Location: to }); res.end(); return; }
    html(res, OG());
  });
  const previews = lp.createLinkPreviews(world());
  for (const path of ["/to-private-name", "/to-private-address", "/to-localhost", "/to-https-private"]) {
    const got = await previews.preview(`http://hop.test${path}`);
    assert.deepEqual([got.state, got.why], ["address", "private"], path);
  }
  assert.deepEqual((({ state, why }) => [state, why])(await previews.preview("http://hop.test/to-file")), ["address", "unread"]);
  assert.equal(hidden.hits.length, 0, "the private host never heard of it");
  assert.equal((await previews.preview("http://hop.test/1")).state, "page", "three redirects are followed");
  assert.deepEqual((({ state, why }) => [state, why])(await previews.preview("http://hop.test/a")), ["address", "unread"], "a fourth is not");
  assert.equal(sites.get("hop.test").hits.filter((h) => h.url === "/d").length + sites.get("hop.test").hits.filter((h) => h.url === "/page").length, 2, "/d was asked (the third hop's answer) and went no further; /page once, for /1");
});

test("only the head is read: it stops at </head>, and at 256 KB when a page never ends its head", async () => {
  const big = await site("big.test", (req, res, me) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    if (req.url === "/early") { res.write(`<html><head><title>Early</title></head><body>`); }
    else res.write("<html><head>");
    // (A page that goes on for ever: 16 KB at a time until the reader hangs up.)
    const chunk = Buffer.alloc(16 * 1024, "x");
    const more = () => { if (res.destroyed || res.writableEnded) return; me.sent += chunk.length; if (res.write(chunk)) setImmediate(more); else res.once("drain", more); };
    res.on("close", () => { me.closed = (me.closed || 0) + 1; });
    more();
  });
  const previews = lp.createLinkPreviews(world());
  const early = await previews.preview("http://big.test/early");
  assert.deepEqual([early.state, early.title], ["page", "Early"]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(big.closed, 1, "hung up once the head had ended");
  const firstSent = big.sent; big.sent = 0;
  assert.ok(firstSent < 2 * 1024 * 1024, `stopped early (${firstSent} bytes written)`);
  const never = await previews.preview("http://big.test/never");
  assert.deepEqual([never.state, never.why], ["address", "unread"], "a head with no words in its first 256 KB has none to show");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(big.closed, 2);
  const read = previews.sent().filter((s) => s.host === "big.test").at(-1).received_bytes;
  assert.ok(read >= 256 * 1024 && read <= 256 * 1024 + 128 * 1024, `about 256 KB was taken, no more (${read})`);
  assert.equal(lp.LIMITS.headBytes, 256 * 1024); assert.equal(lp.LIMITS.timeoutMs, 6000); assert.equal(lp.LIMITS.pictureBytes, 1024 * 1024); assert.equal(lp.LIMITS.redirects, 3);
});

test("six seconds, then it is given up (here: a site that never answers, and one that stalls mid-head)", async () => {
  const slow = await site("slow.test", (req, res) => { if (req.url === "/stall") { res.writeHead(200, { "Content-Type": "text/html" }); res.write("<html><head><title>Half"); } });
  const previews = lp.createLinkPreviews(world({ limits: { timeoutMs: 250 } }));
  for (const path of ["/silent", "/stall"]) {
    const began = Date.now();
    const got = await previews.preview(`http://slow.test${path}`);
    assert.deepEqual([got.state, got.why], ["address", "unread"], path);
    assert.ok(Date.now() - began < 2000, "given up in time");
  }
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(slow.sockets.size, 0, "and hung up");
});

test("a picture: only an image, only 1 MB, only from a public host; a page that isn't HTML has no words", async () => {
  let pictureAsked = 0;
  await site("pics.test", (req, res) => {
    const image = { "/huge": "/huge.png", "/said-huge": "/said-huge.png", "/not-image": "/page.html", "/private": "http://192.168.1.20/cat.png", "/private-name": "http://printer.local/cat.png",
      "/redirected": "/jump.png", "/svg": "/logo.svg" }[req.url];
    if (image) { html(res, OG(`<meta property="og:image" content="${image}">`)); return; }
    pictureAsked++;
    if (req.url === "/huge.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(Buffer.alloc(1200 * 1024, 1)); return; }
    if (req.url === "/said-huge.png") { res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(1500 * 1024) }); res.write(Buffer.alloc(1024)); return; }
    if (req.url === "/page.html") { html(res, "<html></html>"); return; }
    if (req.url === "/jump.png") { res.writeHead(302, { Location: "http://127.0.0.1:1/cat.png" }); res.end(); return; }
    if (req.url === "/logo.svg") { res.writeHead(200, { "Content-Type": "image/svg+xml" }); res.end(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`); return; }
    if (req.url === "/doc.pdf") { res.writeHead(200, { "Content-Type": "application/pdf" }); res.end("%PDF-1.7"); return; }
    if (req.url === "/data.json") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(`{"title":"<title>no</title>"}`); return; }
    res.writeHead(404); res.end();
  });
  const previews = lp.createLinkPreviews(world());
  for (const path of ["/huge", "/said-huge", "/not-image", "/private", "/private-name", "/redirected", "/svg"]) {
    const got = await previews.preview(`http://pics.test${path}`);
    assert.deepEqual([got.state, got.title, got.image], ["page", "OpenRouter", undefined], `${path}: the words, and no picture`);
  }
  assert.equal(pictureAsked, 6 - 1, "the private ones were never asked for (their page's own host heard five)");
  for (const path of ["/doc.pdf", "/data.json", "/missing"]) assert.deepEqual((({ state, why }) => [state, why])(await previews.preview(`http://pics.test${path}`)), ["address", "unread"], path);
});

test("kept for 24 hours: a second look asks nothing, in memory and from the small folder on disk", async () => {
  const dir = join(scratch, "cache");
  let now = Date.parse("2026-11-22T10:00:00Z");
  const kept = sites.get("pub.test"); kept.hits.length = 0;
  const first = lp.createLinkPreviews(world({ dir, now: () => now }));
  const a = await first.preview("http://pub.test/cached");
  assert.equal(kept.hits.length, 3);
  now += 23 * 3_600_000;
  assert.deepEqual(await first.preview("http://pub.test/cached#again"), a, "the same answer (a fragment is the same page)");
  assert.equal(kept.hits.length, 3, "and nothing was asked");
  // Another window (a new host): from the folder.
  await first.settled();
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/, "named by a digest of the address, never the address");
  assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, files[0]), "utf8").includes("pub.test/cached"), false, "the address itself is not written down");
  const second = lp.createLinkPreviews(world({ dir, now: () => now }));
  assert.deepEqual(await second.preview("http://pub.test/cached"), a);
  assert.equal(kept.hits.length, 3);
  now += 2 * 3_600_000;                                   // past 24 hours: read again
  assert.equal((await second.preview("http://pub.test/cached")).title, "OpenRouter");
  assert.equal(kept.hits.length, 6);
  // A page that could not be read is not asked again at once, and is never written down.
  await second.settled();
  const before = readdirSync(dir).length;
  await second.preview("http://pub.test/reset/now"); await second.preview("http://localhost/"); await second.settled();
  assert.equal(readdirSync(dir).length, before, "an address-only answer keeps nothing");
  // The folder stays small: the oldest go.
  const small = lp.createLinkPreviews(world({ dir, now: () => now, limits: { diskFiles: 3 } }));
  for (let i = 0; i < 6; i++) { now += 1000; await small.preview(`http://pub.test/n/${i}`); }
  await small.settled();
  assert.ok(readdirSync(dir).length <= 3, `at most three kept (${readdirSync(dir).length})`);
});

// ---- the page's question and the setting --------------------------------------------------------------------------------
test("a page's question: reading, then the page; from the cache at once; the same again says so; off says off", async () => {
  const kept = sites.get("pub.test"); kept.hits.length = 0;
  const previews = lp.createLinkPreviews(world());
  const said = [];
  assert.equal(await previews.handle({ type: "dgcLinkPreview", id: "q1", url: "http://pub.test/ask" }, (m) => said.push(m)), true);
  assert.deepEqual(said.map((m) => [m.type, m.id, m.state]), [["dgcLinkPreview", "q1", "reading"], ["dgcLinkPreview", "q1", "page"]]);
  assert.equal(said[0].site, "pub.test");
  assert.equal(said[1].title, "OpenRouter");
  assert.match(said[1].image, /^data:image\/png;base64,/);
  said.length = 0;
  await previews.handle({ type: "dgcLinkPreview", id: "q2", url: "http://pub.test/ask" }, (m) => said.push(m));
  assert.deepEqual(said.map((m) => m.state), ["page"], "kept: answered at once");
  const at = said[0].at;
  said.length = 0;
  await previews.handle({ type: "dgcLinkPreview", id: "q3", url: "http://pub.test/ask", have: at }, (m) => said.push(m));
  assert.deepEqual(said, [{ type: "dgcLinkPreview", id: "q3", url: "http://pub.test/ask", state: "same" }], "the page already holds it: its picture isn't sent again");
  said.length = 0;
  await previews.handle({ type: "dgcLinkPreview", id: "q4", url: "http://localhost:5173/" }, (m) => said.push(m));
  assert.deepEqual(said, [{ type: "dgcLinkPreview", id: "q4", url: "http://localhost:5173/", state: "address", why: "private", site: "localhost:5173" }]);
  // Off: nothing is read, whatever is kept.
  settings.linkPreviews = false;
  try {
    kept.hits.length = 0; said.length = 0;
    await previews.handle({ type: "dgcLinkPreview", id: "q5", url: "http://pub.test/ask" }, (m) => said.push(m));
    await previews.handle({ type: "dgcLinkPreview", id: "q6", url: "http://pub.test/new" }, (m) => said.push(m));
    assert.deepEqual(said.map((m) => [m.id, m.state]), [["q5", "off"], ["q6", "off"]]);
    assert.equal(kept.hits.length, 0);
    assert.equal(lp.linkPreviewsOn(), false, "dgc.linkPreviews, as the editor holds it");
  } finally { settings.linkPreviews = true; }
  assert.equal(lp.linkPreviewsOn(), true);
  // Anything that isn't the question is not answered.
  said.length = 0;
  for (const bad of [null, {}, { type: "dgcLinkPreview" }, { type: "dgcLinkPreview", id: 7, url: "http://pub.test/" }, { type: "dgcLinkPreview", id: "x".repeat(65), url: "http://pub.test/" },
    { type: "dgcLinkPreview", id: "q", url: "x".repeat(9000) }, { type: "dgcLinkPreview", id: "q", url: 42 }, { type: "other", id: "q", url: "http://pub.test/" }]) {
    assert.equal(await previews.handle(bad, (m) => said.push(m)), bad?.type === "dgcLinkPreview", JSON.stringify(bad)?.slice(0, 60));
  }
  assert.deepEqual(said, []);
  said.length = 0;
  await previews.handle({ type: "dgcLinkPreview", id: "q7", url: "ftp://pub.test/file" }, (m) => said.push(m));
  assert.deepEqual(said.map((m) => [m.state, m.why]), [["address", "not-web"]]);
});

test("many at once: one read for one address, and no more than a few sites at a time", async () => {
  let open = 0, most = 0;
  await site("crowd.test", (req, res) => { open++; most = Math.max(most, open); setTimeout(() => { open--; html(res, OG()); }, 40); });
  const previews = lp.createLinkPreviews(world());
  const same = await Promise.all(Array.from({ length: 5 }, () => previews.preview("http://crowd.test/one")));
  assert.equal(sites.get("crowd.test").hits.length, 1, "asked once for five who pointed at it");
  assert.ok(same.every((p) => p.title === "OpenRouter"));
  const many = await Promise.all(Array.from({ length: 12 }, (_, i) => previews.preview(`http://crowd.test/p/${i}`)));
  assert.ok(most <= lp.LIMITS.atOnce, `never more than ${lp.LIMITS.atOnce} at once (${most})`);
  assert.ok(many.every((p) => p.state === "page"), "the rest waited their turn");
});

test("today's record: one row per site, newest first, counting each read; yesterday's left out", () => {
  const now = new Date("2026-11-22T15:00:00").getTime(), hour = 3_600_000;
  const rows = lp.sentToday([
    { at: now - 26 * hour, host: "old.example", kind: "page", status: 200, received_bytes: 10 },
    { at: now - 3 * hour, host: "github.com", kind: "page", status: 200, received_bytes: 1000 },
    { at: now - 2 * hour, host: "openrouter.ai", kind: "page", status: 200, received_bytes: 5000 },
    { at: now - 2 * hour + 1, host: "openrouter.ai", kind: "picture", status: 200, received_bytes: 400000 },
  ], now);
  assert.deepEqual(rows.map((r) => [r.host, r.times, r.bytes]), [["openrouter.ai", 2, 405000], ["github.com", 1, 1000]]);
});

// User test round 2, W19: a page with no description of its own in its head (pytest's documentation) made a card of
// the site's name and the link's own words again. The page's first paragraph is its description then, from what was
// already read: nothing more is fetched, and a page with no paragraph worth saying still says nothing.
test("W19: a page with no description in its head is described by its own first paragraph, from what was read", () => {
  const page = (body, head = "<title>pytest documentation</title>") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
  const docs = page(`<nav><p>Home</p><a href="/x">Skip to main content</a></nav><header><p>pytest 8 documentation: quick search and the other versions of these pages</p></header>
    <main><h1>pytest: helps you write better programs</h1><p>The <code>pytest</code> framework makes it easy to write small, readable tests, and can scale to support complex functional testing for applications &amp; libraries.</p>
    <p>A second paragraph that is not the description.</p></main><script>var p = "<p>This is in a script and is long enough to be taken for a paragraph of the page</p>";</script>`);
  const said = lp.parseHead(docs, "https://docs.pytest.example/en/stable/");
  assert.equal(said.title, "pytest documentation");
  assert.equal(said.description, "The pytest framework makes it easy to write small, readable tests, and can scale to support complex functional testing for applications & libraries.");
  // The head's own description always wins.
  assert.equal(lp.parseHead(page("<p>The pytest framework makes it easy to write small, readable tests for every project.</p>", '<title>t</title><meta name="description" content="Said by the page itself.">'), "https://e.example/").description, "Said by the page itself.");
  // Nothing worth saying: nothing said. (A menu's words, a cookie line, a paragraph of three words.)
  assert.equal(lp.parseHead(page("<nav><p>Docs Blog Pricing Sign in and a few more links to fill the line up</p></nav><p>Too short.</p><footer><p>Copyright 2026 Example Inc. All rights reserved, in every country where that means something.</p></footer>"), "https://e.example/").description, "");
  assert.equal(lp.parseHead(page('<p>We use cookies to make this site work and to see how it is used; accept all cookies or choose.</p>'), "https://e.example/").description, "");
  // A long first paragraph is cut at a word, with an ellipsis; markup and control characters never come through.
  const long = lp.parseHead(page(`<p>${"Every loaf is shaped by hand and baked on stone. ".repeat(12)}<b>bold</b><img src=x onerror=alert(1)></p>`), "https://e.example/").description;
  assert.ok(long.length <= 240 && long.endsWith("…") && !/[<>]/.test(long), long);
});
