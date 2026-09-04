#!/usr/bin/env node

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import worker from "../site/_worker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const MIGRATION = readFileSync(join(ROOT, "migrations", "0001_site.sql"), "utf8");
const SECRET = "worker-test-secret-that-is-longer-than-thirty-two-bytes";
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const databases = [];
const tests = [];
let emailCalls = [];
let emailResponder = async () => new Response(JSON.stringify({id: "email-default"}), {
  status: 200,
  headers: {"content-type": "application/json"},
});

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url !== "https://api.resend.com/emails") {
    throw new Error("Unexpected outbound fetch: " + url);
  }
  const call = {url, init, body: JSON.parse(String(init.body || "{}"))};
  emailCalls.push(call);
  return emailResponder(call);
};

function isWrite(sql) {
  return /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql.trim());
}

class D1Statement {
  constructor(owner, sql, bindings = []) {
    this.owner = owner;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new D1Statement(this.owner, this.sql, bindings);
  }

  statement() {
    return this.owner.sqlite.prepare(this.sql);
  }

  noteExecution() {
    this.owner.executions += 1;
    if (isWrite(this.sql)) this.owner.writeExecutions += 1;
    this.owner.maybeFail(this.sql);
  }

  async first(columnName) {
    this.noteExecution();
    const row = this.statement().get(...this.bindings) || null;
    if (row === null || columnName === undefined) return row;
    if (!(columnName in row)) throw new Error("D1 column not found: " + columnName);
    return row[columnName];
  }

  async run() {
    return this.executeForBatch();
  }

  executeForBatch() {
    this.noteExecution();
    const statement = this.statement();
    if (/\bRETURNING\b/i.test(this.sql) || /^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(this.sql)) {
      const results = statement.all(...this.bindings);
      const changes = isWrite(this.sql)
        ? Number(this.owner.sqlite.prepare("SELECT changes() AS value").get().value)
        : 0;
      return {success: true, results, meta: {changes}};
    }
    const result = statement.run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class MemoryD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(MIGRATION);
    this.executions = 0;
    this.writeExecutions = 0;
    this.failures = [];
    databases.push(this);
  }

  failNext(sqlFragment) {
    this.failures.push(sqlFragment);
  }

  maybeFail(sql) {
    const index = this.failures.findIndex(fragment => sql.includes(fragment));
    if (index < 0) return;
    const [fragment] = this.failures.splice(index, 1);
    throw new Error("Injected D1 failure for: " + fragment);
  }

  prepare(sql) {
    return new D1Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(statement => statement.executeForBatch());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  rows(sql, ...bindings) {
    return this.sqlite.prepare(sql).all(...bindings);
  }

  value(sql, ...bindings) {
    const row = this.sqlite.prepare(sql).get(...bindings);
    return row ? Object.values(row)[0] : null;
  }

  close() {
    this.sqlite.close();
  }
}

const ROUTES = [
  "/", "/benchmark", "/subscription", "/vscode",
  "/docs", "/docs/getting-started", "/docs/redirect-local",
  "/docs/redirect-external",
];

class AssetsMock {
  constructor({failRoutes = 0} = {}) {
    this.failRoutes = failRoutes;
    this.calls = [];
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.calls.push({url: url.toString(), method: request.method});
    if (url.pathname === "/routes.json") {
      if (this.failRoutes > 0) {
        this.failRoutes -= 1;
        return new Response("unavailable", {status: 503});
      }
      return new Response(JSON.stringify({html: ROUTES}), {
        headers: {"content-type": "application/json"},
      });
    }
    if (url.pathname === "/404.html") {
      return new Response("MAIN_404", {headers: {"content-type": "text/html"}});
    }
    if (url.pathname === "/docs/404.html") {
      return new Response("DOCS_404", {headers: {"content-type": "text/html"}});
    }
    if (url.pathname === "/docs/redirect-local") {
      return new Response(null, {
        status: 308,
        headers: {location: "https://docs.vibedgc.com/docs/getting-started/"},
      });
    }
    if (url.pathname === "/docs/redirect-external") {
      return new Response(null, {
        status: 302,
        headers: {location: "https://example.com/docs/leave-intact"},
      });
    }
    const pages = new Map([
      ["/", "HOME"], ["/index.html", "HOME"],
      ["/benchmark", "BENCHMARK"], ["/benchmark.html", "BENCHMARK"],
      ["/subscription", "SUBSCRIPTION"], ["/subscription.html", "SUBSCRIPTION"],
      ["/vscode", "VSCODE"], ["/vscode/", "VSCODE"],
      ["/docs/", "DOCS_HOME"], ["/docs", "DOCS_HOME"],
      ["/docs/getting-started", "DOCS_GETTING_STARTED"],
      ["/docs/getting-started/", "DOCS_GETTING_STARTED"],
    ]);
    if (pages.has(url.pathname)) {
      return new Response(request.method === "HEAD" ? null : pages.get(url.pathname), {
        headers: {"content-type": "text/html; charset=utf-8"},
      });
    }
    if (url.pathname === "/assets/private.js") {
      return new Response(request.method === "HEAD" ? null : "PRIVATE", {
        headers: {"content-type": "text/javascript", "cache-control": "no-store"},
      });
    }
    const assets = new Map([
      ["/install.sh", "#!/bin/sh\necho install\n"],
      ["/dgc.tar.gz", "TARBALL"],
      ["/dgc.tar.gz.sha256", "CHECKSUM"],
      ["/vscode/dgc.vsix", "VSIX"],
      ["/vscode/dgc-0.25.2.vsix", "VERSIONED_VSIX"],
      ["/site.webmanifest", "MANIFEST"],
      ["/assets/site.css", "CSS"],
      ["/assets/font.woff2", "FONT"],
      ["/assets/capture.mp4", "VIDEO"],
      ["/evidence/run.json", "EVIDENCE"],
    ]);
    if (assets.has(url.pathname)) {
      return new Response(request.method === "HEAD" ? null : assets.get(url.pathname), {
        headers: {"content-type": "application/octet-stream"},
      });
    }
    return new Response("ASSET_404", {status: 404});
  }
}

const analytics = () => ({
  points: [],
  writeDataPoint(point) {
    this.points.push(point);
  },
});

function environment(overrides = {}) {
  return {
    ASSETS: overrides.ASSETS || sharedAssets,
    DGC_SITE_DB: overrides.DGC_SITE_DB === undefined ? new MemoryD1() : overrides.DGC_SITE_DB,
    DGC_ANALYTICS: overrides.DGC_ANALYTICS || analytics(),
    DGC_ENVIRONMENT: overrides.DGC_ENVIRONMENT || "production",
    DGC_RATE_LIMIT_SECRET: overrides.DGC_RATE_LIMIT_SECRET === undefined
      ? SECRET : overrides.DGC_RATE_LIMIT_SECRET,
    RESEND_API_KEY: overrides.RESEND_API_KEY === undefined ? "re_test" : overrides.RESEND_API_KEY,
    DGC_FROM_EMAIL: overrides.DGC_FROM_EMAIL === undefined
      ? "DGC <release@vibedgc.com>" : overrides.DGC_FROM_EMAIL,
    DGC_CONTACT_EMAIL: overrides.DGC_CONTACT_EMAIL === undefined
      ? "hello@vibedgc.com" : overrides.DGC_CONTACT_EMAIL,
  };
}

function request(path, {base = "https://vibedgc.com", method = "GET", headers = {}, body} = {}) {
  const init = {method, headers: new Headers(headers)};
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = "half";
  }
  return new Request(new URL(path, base), init);
}

function browserPost(path, body, options = {}) {
  const base = options.base || "https://vibedgc.com";
  const origin = options.origin === undefined ? new URL(base).origin : options.origin;
  const headers = {
    accept: "application/json",
    origin,
    "sec-fetch-site": options.fetchSite || "same-origin",
    "cf-connecting-ip": options.ip || "203.0.113.10",
    ...(options.headers || {}),
  };
  return request(path, {base, method: "POST", headers, body});
}

function urlencoded(fields) {
  return new URLSearchParams(fields);
}

function multipart(fields, boundary = "AaB03xCaseSensitiveBoundary") {
  let body = "";
  for (const [name, value] of Object.entries(fields)) {
    body += "--" + boundary + "\r\n";
    body += `Content-Disposition: form-data; name="${name}"\r\n\r\n`;
    body += value + "\r\n";
  }
  body += "--" + boundary + "--\r\n";
  return {body, type: "multipart/form-data; boundary=" + boundary};
}

function streamOf(size, byte = "x") {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(byte.repeat(size)));
      controller.close();
    },
  });
}

function resetEmail(responder) {
  emailCalls = [];
  emailResponder = responder || (async () => new Response(JSON.stringify({id: "email-ok"}), {
    status: 200,
    headers: {"content-type": "application/json"},
  }));
}

function assertSecurity(response, {preview = false} = {}) {
  assert.equal(response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains; preload");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-robots-tag"), preview ? "noindex, nofollow" : null);
}

function register(name, fn) {
  tests.push({name, fn});
}

const sharedAssets = new AssetsMock({failRoutes: 1});

register("route manifest failure is hardened and recoverable", async () => {
  const env = environment({ASSETS: sharedAssets});
  const first = await worker.fetch(request("/"), env);
  assert.equal(first.status, 503);
  assertSecurity(first);
  const second = await worker.fetch(request("/"), env);
  assert.equal(second.status, 200);
  assert.equal(await second.text(), "HOME");
  assertSecurity(second);
});

register("dotted downloads ignore browser HTML Accept and HEAD has parity", async () => {
  const env = environment();
  const cases = new Map([
    ["/dgc.tar.gz", "TARBALL"],
    ["/dgc.tar.gz.sha256", "CHECKSUM"],
    ["/vscode/dgc.vsix", "VSIX"],
    ["/site.webmanifest", "MANIFEST"],
    ["/assets/font.woff2", "FONT"],
    ["/assets/capture.mp4", "VIDEO"],
  ]);
  for (const [path, expected] of cases) {
    const response = await worker.fetch(request(path, {headers: {accept: "text/html,*/*"}}), env);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), expected, path);
    assertSecurity(response);
    const head = await worker.fetch(request(path, {method: "HEAD", headers: {accept: "text/html,*/*"}}), env);
    assert.equal(head.status, 200, "HEAD " + path);
    assertSecurity(head);
  }
});

register("static responses enforce explicit cache and installer content-type policy", async () => {
  const env = environment();
  const cases = [
    ["/", "no-cache", "text/html; charset=utf-8"],
    ["/install.sh", "no-cache", "text/plain; charset=utf-8"],
    ["/dgc.tar.gz", "no-cache", "application/octet-stream"],
    ["/dgc.tar.gz.sha256", "no-cache", "application/octet-stream"],
    ["/vscode/dgc.vsix", "no-cache", "application/octet-stream"],
    ["/site.webmanifest", "no-cache", "application/octet-stream"],
    ["/assets/site.css", "public, max-age=3600, must-revalidate", "application/octet-stream"],
    ["/assets/private.js", "no-store", "text/javascript"],
    ["/evidence/run.json", "public, max-age=86400, immutable", "application/octet-stream"],
    ["/vscode/dgc-0.25.2.vsix", "public, max-age=31536000, immutable", "application/octet-stream"],
  ];
  for (const [path, cacheControl, contentType] of cases) {
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), cacheControl, path);
    assert.equal(response.headers.get("content-type"), contentType, path);
    assertSecurity(response);
  }
});

register("HTML 404s, docs mapping, redirects, and Location rewriting are exact", async () => {
  const env = environment();
  const missing = await worker.fetch(request("/not-a-route", {headers: {accept: "text/html"}}), env);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "MAIN_404");
  assertSecurity(missing);

  const docsMissing = await worker.fetch(request("/not-a-route", {
    base: "https://docs.vibedgc.com", headers: {accept: "text/html"},
  }), env);
  assert.equal(docsMissing.status, 404);
  assert.equal(await docsMissing.text(), "DOCS_404");

  const docs = await worker.fetch(request("/getting-started", {
    base: "https://docs.vibedgc.com", headers: {accept: "text/html"},
  }), env);
  assert.equal(docs.status, 200);
  assert.equal(await docs.text(), "DOCS_GETTING_STARTED");

  const mainFromDocs = await worker.fetch(request("/benchmark", {
    base: "https://docs.vibedgc.com", headers: {accept: "text/html"},
  }), env);
  assert.equal(mainFromDocs.status, 301);
  assert.equal(mainFromDocs.headers.get("location"), "https://vibedgc.com/benchmark");
  assert.equal(mainFromDocs.headers.get("cache-control"), "no-store");
  assert.equal(mainFromDocs.headers.get("referrer-policy"), "no-referrer");

  const local = await worker.fetch(request("/redirect-local", {
    base: "https://docs.vibedgc.com", headers: {accept: "text/html"},
  }), env);
  assert.equal(local.status, 308);
  assert.equal(local.headers.get("location"), "https://docs.vibedgc.com/getting-started/");

  const external = await worker.fetch(request("/redirect-external", {
    base: "https://docs.vibedgc.com", headers: {accept: "text/html"},
  }), env);
  assert.equal(external.status, 302);
  assert.equal(external.headers.get("location"), "https://example.com/docs/leave-intact");
});

register("canonical redirects clear attacker-supplied ports and preview is noindex", async () => {
  const env = environment();
  const alien = await worker.fetch(request("/benchmark", {base: "http://evil.test:8080"}), env);
  assert.equal(alien.status, 301);
  assert.equal(alien.headers.get("location"), "https://vibedgc.com/benchmark");
  assertSecurity(alien);
  const insecure = await worker.fetch(request("/benchmark", {base: "http://vibedgc.com:8080"}), env);
  assert.equal(insecure.headers.get("location"), "https://vibedgc.com/benchmark");

  const preview = await worker.fetch(request("/", {base: "https://build.pages.dev"}), env);
  assert.equal(preview.status, 200);
  assertSecurity(preview, {preview: true});
});

register("forms fail closed for environment, D1, HMAC, IP, and origin errors", async () => {
  const form = () => urlencoded({email: "person@example.com", website: ""});
  const noDb = environment({DGC_SITE_DB: null});
  assert.equal((await worker.fetch(browserPost("/api/subscribe", form()), noDb)).status, 503);

  const noSecret = environment({DGC_RATE_LIMIT_SECRET: "short"});
  assert.equal((await worker.fetch(browserPost("/api/subscribe", form()), noSecret)).status, 503);

  const development = environment({DGC_ENVIRONMENT: "development"});
  assert.equal((await worker.fetch(browserPost("/api/subscribe", form()), development)).status, 503);

  const broken = environment({
    DGC_SITE_DB: {prepare() { throw new Error("D1 unavailable"); }, async batch() { throw new Error("D1 unavailable"); }},
  });
  resetEmail();
  assert.equal((await worker.fetch(browserPost("/api/subscribe", form()), broken)).status, 503);
  assert.equal(emailCalls.length, 0);

  const env = environment();
  const wrongOrigin = await worker.fetch(browserPost("/api/subscribe", form(), {
    origin: "https://attacker.example",
  }), env);
  assert.equal(wrongOrigin.status, 403);
  assertSecurity(wrongOrigin);
  assert.equal((await worker.fetch(browserPost("/api/subscribe", form(), {
    origin: "http://vibedgc.com",
  }), env)).status, 403);
  assert.equal((await worker.fetch(browserPost("/api/subscribe", form(), {
    fetchSite: "cross-site",
  }), env)).status, 403);
  assert.equal((await worker.fetch(browserPost("/api/subscribe", form(), {
    headers: {"cf-connecting-ip": ""},
  }), env)).status, 503);
  assert.equal((await worker.fetch(browserPost("/api/subscribe", form(), {
    base: "https://vibedgc.com:444",
  }), env)).status, 503);
  const unsupportedSubdomain = await worker.fetch(browserPost("/api/subscribe", form(), {
    base: "https://other.vibedgc.com",
  }), env);
  assert.equal(unsupportedSubdomain.status, 301);
  assert.equal(unsupportedSubdomain.headers.get("location"), "https://vibedgc.com/api/subscribe");
  assert.equal((await worker.fetch(browserPost("/api/subscribe", form(), {
    base: "https://build.pages.dev",
  }), env)).status, 503);

  resetEmail();
  const www = await worker.fetch(browserPost("/api/subscribe", urlencoded({
    email: "www@example.com", website: "",
  }), {
    base: "https://www.vibedgc.com", ip: "203.0.113.11",
  }), env);
  assert.equal(www.status, 301);
  assert.equal(www.headers.get("location"), "https://vibedgc.com/api/subscribe");
  assert.equal((await worker.fetch(browserPost("/api/subscribe", urlencoded({
    email: "docs@example.com", website: "",
  }), {
    base: "https://docs.vibedgc.com", ip: "203.0.113.12",
  }), env)).status, 201);
  const wrongMethod = await worker.fetch(request("/api/subscribe"), env);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
});

register("rate and destination claims remain atomic under concurrent requests", async () => {
  const limited = environment();
  resetEmail();
  const attempts = await Promise.all(Array.from({length: 7}, (_, index) => worker.fetch(
    browserPost("/api/subscribe", urlencoded({
      email: `parallel-${index}@example.com`, website: "",
    }), {ip: "203.0.113.15"}),
    limited,
  )));
  assert.deepEqual(
    attempts.map(response => response.status).sort((a, b) => a - b),
    [201, 201, 201, 201, 201, 201, 429],
  );
  assert.equal(emailCalls.length, 6);
  assert.equal(limited.DGC_SITE_DB.value("SELECT count FROM rate_limits WHERE kind='subscribe'"), 6);

  const cooldown = environment();
  resetEmail();
  const sameDestination = await Promise.all([
    worker.fetch(browserPost("/api/subscribe", urlencoded({
      email: "one-address@example.com", website: "",
    }), {ip: "203.0.113.16"}), cooldown),
    worker.fetch(browserPost("/api/subscribe", urlencoded({
      email: "one-address@example.com", website: "",
    }), {ip: "203.0.113.17"}), cooldown),
  ]);
  assert.deepEqual(sameDestination.map(response => response.status).sort(), [201, 429]);
  assert.equal(emailCalls.length, 1);
  assert.equal(cooldown.DGC_SITE_DB.value("SELECT count(*) FROM form_cooldowns"), 1);
  assert.equal(cooldown.DGC_SITE_DB.value("SELECT count(*) FROM pending_subscriptions"), 1);
});

register("mixed-case multipart boundary parses and observed/declared limits hold", async () => {
  const env = environment();
  resetEmail();
  const mixed = multipart({email: "mixed@example.com", website: ""});
  const response = await worker.fetch(browserPost("/api/subscribe", mixed.body, {
    ip: "203.0.113.20", headers: {"content-type": mixed.type},
  }), env);
  assert.equal(response.status, 201);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM pending_subscriptions"), 1);

  const oversized = await worker.fetch(browserPost("/api/subscribe", streamOf(16_385), {
    ip: "203.0.113.21", headers: {"content-type": "application/json"},
  }), env);
  assert.equal(oversized.status, 413);

  const declared = await worker.fetch(browserPost("/api/subscribe", "{}", {
    ip: "203.0.113.22",
    headers: {"content-type": "application/json", "content-length": "20000"},
  }), env);
  assert.equal(declared.status, 413);

  const objectField = await worker.fetch(browserPost("/api/subscribe", JSON.stringify({
    email: {value: "person@example.com"}, website: "",
  }), {
    ip: "203.0.113.23", headers: {"content-type": "application/json"},
  }), env);
  assert.equal(objectField.status, 400);

  const points = env.DGC_ANALYTICS.points.length;
  const event = await worker.fetch(browserPost("/api/event", streamOf(1_025), {
    ip: "203.0.113.24",
    headers: {"content-type": "application/json", referer: "https://vibedgc.com/benchmark"},
  }), env);
  assert.equal(event.status, 204);
  assert.equal(env.DGC_ANALYTICS.points.length, points);
});

register("canonical HTML GET records one page view and excluded requests record none", async () => {
  const canonical = environment();
  const page = await worker.fetch(request("/benchmark?source=qa", {
    headers: {"user-agent": "Mozilla/5.0"},
  }), canonical);
  assert.equal(page.status, 200);
  assert.equal(canonical.DGC_ANALYTICS.points.length, 1);
  assert.deepEqual(canonical.DGC_ANALYTICS.points[0], {
    indexes: ["page_view"],
    blobs: ["vibedgc.com", "/benchmark", "desktop"],
    doubles: [1],
  });

  const revalidated = environment({
    ASSETS: {
      async fetch(assetRequest) {
        const pathname = new URL(assetRequest.url).pathname;
        if (pathname === "/benchmark") return new Response(null, {status: 304});
        return sharedAssets.fetch(assetRequest);
      },
    },
  });
  const notModified = await worker.fetch(request("/benchmark", {
    headers: {"if-none-match": "\"cached-page\"", "user-agent": "Mozilla/5.0"},
  }), revalidated);
  assert.equal(notModified.status, 304);
  assert.deepEqual(revalidated.DGC_ANALYTICS.points, [{
    indexes: ["page_view"],
    blobs: ["vibedgc.com", "/benchmark", "desktop"],
    doubles: [1],
  }]);

  const excluded = [
    ["HEAD", request("/benchmark", {method: "HEAD"}), 200],
    ["redirect", request("/benchmark", {base: "https://www.vibedgc.com"}), 301],
    ["404", request("/missing-page", {headers: {accept: "text/html"}}), 404],
    ["preview", request("/benchmark", {base: "https://branch.pages.dev"}), 200],
    ["DNT", request("/benchmark", {headers: {dnt: "1"}}), 200],
    ["GPC", request("/benchmark", {headers: {"sec-gpc": "1"}}), 200],
  ];
  for (const [label, excludedRequest, expectedStatus] of excluded) {
    const env = environment();
    const response = await worker.fetch(excludedRequest, env);
    assert.equal(response.status, expectedStatus, label);
    assert.equal(env.DGC_ANALYTICS.points.length, 0, label);
  }
});

register("valid analytics derives path from Referer and honors DNT", async () => {
  const env = environment();
  const eventBody = JSON.stringify({event: "marketplace", path: "/forged"});
  const valid = await worker.fetch(browserPost("/api/event", eventBody, {
    ip: "203.0.113.30",
    headers: {"content-type": "application/json", referer: "https://vibedgc.com/vscode"},
  }), env);
  assert.equal(valid.status, 204);
  assert.equal(env.DGC_ANALYTICS.points.length, 1);
  assert.equal(env.DGC_ANALYTICS.points[0].blobs[1], "/vscode");

  const before = env.DGC_SITE_DB.executions;
  await worker.fetch(browserPost("/api/event", eventBody, {
    ip: "203.0.113.31",
    headers: {
      "content-type": "application/json", referer: "https://vibedgc.com/vscode", dnt: "1",
    },
  }), env);
  assert.equal(env.DGC_ANALYTICS.points.length, 1);
  assert.equal(env.DGC_SITE_DB.executions, before);
});

register("docs getting-started beacon derives its path from the docs Referer", async () => {
  const env = environment();
  const response = await worker.fetch(browserPost("/api/event", JSON.stringify({
    event: "docs_getting_started_reached",
    path: "/forged-client-path",
  }), {
    base: "https://docs.vibedgc.com",
    ip: "203.0.113.34",
    headers: {
      "content-type": "application/json",
      referer: "https://docs.vibedgc.com/getting-started?source=qa",
    },
  }), env);
  assert.equal(response.status, 204);
  assert.equal(env.DGC_ANALYTICS.points.length, 1);
  assert.deepEqual(env.DGC_ANALYTICS.points[0], {
    indexes: ["docs_getting_started_reached"],
    blobs: ["docs.vibedgc.com", "/getting-started", "desktop"],
    doubles: [1],
  });
});

register("preview and attacker subdomains cannot record analytics", async () => {
  const env = environment();
  const body = JSON.stringify({event: "marketplace"});
  const before = env.DGC_SITE_DB.executions;

  const preview = await worker.fetch(browserPost("/api/event", body, {
    base: "https://branch.pages.dev",
    ip: "203.0.113.32",
    headers: {
      "content-type": "application/json",
      referer: "https://branch.pages.dev/vscode",
    },
  }), env);
  assert.equal(preview.status, 204);
  assertSecurity(preview, {preview: true});
  assert.equal(env.DGC_ANALYTICS.points.length, 0);
  assert.equal(env.DGC_SITE_DB.executions, before);

  const attacker = await worker.fetch(browserPost("/api/event", body, {
    base: "https://evil.vibedgc.com",
    ip: "203.0.113.33",
    headers: {
      "content-type": "application/json",
      referer: "https://evil.vibedgc.com/vscode",
    },
  }), env);
  assert.equal(attacker.status, 301);
  assert.equal(attacker.headers.get("location"), "https://vibedgc.com/api/event");
  assert.equal(env.DGC_ANALYTICS.points.length, 0);
  assert.equal(env.DGC_SITE_DB.executions, before);

  const previewDownload = await worker.fetch(request("/dgc.tar.gz", {
    base: "https://branch.pages.dev",
  }), env);
  assert.equal(previewDownload.status, 200);
  assert.equal(env.DGC_ANALYTICS.points.length, 0);

  const localAnalytics = analytics();
  const local = environment({
    DGC_ENVIRONMENT: "development",
    DGC_ANALYTICS: localAnalytics,
  });
  const localDownload = await worker.fetch(request("/install.sh", {
    base: "http://localhost:8788",
  }), local);
  assert.equal(localDownload.status, 200);
  assert.equal(localAnalytics.points.length, 0);
});

register("subscription success persists first, sends an idempotent email, and reuses pending", async () => {
  const env = environment();
  resetEmail();
  const first = await worker.fetch(browserPost("/api/subscribe", urlencoded({
    email: "subscriber@example.com", website: "",
  }), {ip: "203.0.113.40"}), env);
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assertSecurity(first);
  assert.equal(emailCalls.length, 1);
  const pending = env.DGC_SITE_DB.rows("SELECT * FROM pending_subscriptions")[0];
  assert.notEqual(pending.unsubscribe_token, pending.token);
  assert.equal(pending.delivery_state, "accepted");
  assert.equal(emailCalls[0].init.headers["idempotency-key"], pending.idempotency_key);
  assert.match(emailCalls[0].body.text, new RegExp("token=" + pending.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(emailCalls[0].body.text, new RegExp(
    "token=" + pending.unsubscribe_token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ));

  env.DGC_SITE_DB.sqlite.exec("DELETE FROM form_cooldowns");
  const second = await worker.fetch(browserPost("/api/subscribe", urlencoded({
    email: "subscriber@example.com", website: "",
  }), {ip: "203.0.113.41"}), env);
  assert.equal(second.status, 201);
  assert.equal(emailCalls.length, 2);
  assert.equal(emailCalls[1].init.headers["idempotency-key"], pending.idempotency_key);
  assert.match(emailCalls[1].body.text, new RegExp("token=" + pending.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM pending_subscriptions"), 1);
});

register("definitive subscription rejection cleans state; ambiguous states retain it", async () => {
  const definitive = environment();
  resetEmail(async () => new Response(JSON.stringify({name: "validation_error"}), {
    status: 400, headers: {"content-type": "application/json"},
  }));
  const rejected = await worker.fetch(browserPost("/api/subscribe", urlencoded({
    email: "reject@example.com", website: "",
  }), {ip: "203.0.113.50"}), definitive);
  assert.equal(rejected.status, 503);
  assert.equal(definitive.DGC_SITE_DB.value("SELECT count(*) FROM pending_subscriptions"), 0);
  assert.equal(definitive.DGC_SITE_DB.value("SELECT count(*) FROM form_cooldowns"), 0);

  const ambiguousResponses = [
    [500, "application_error"],
    [503, "service_unavailable"],
    [409, "concurrent_idempotent_requests"],
    [409, "resource_locked"],
  ];
  for (const [index, [status, name]] of ambiguousResponses.entries()) {
    const ambiguous = environment();
    resetEmail(async () => new Response(JSON.stringify({name}), {
      status, headers: {"content-type": "application/json"},
    }));
    const uncertain = await worker.fetch(browserPost("/api/subscribe", urlencoded({
      email: `uncertain-${index}@example.com`, website: "",
    }), {ip: `203.0.113.${51 + index}`}), ambiguous);
    assert.equal(uncertain.status, 503, `${status} ${name}`);
    assert.equal(ambiguous.DGC_SITE_DB.value(
      "SELECT count(*) FROM pending_subscriptions",
    ), 1, `${status} ${name}`);
    assert.equal(ambiguous.DGC_SITE_DB.value(
      "SELECT delivery_state FROM pending_subscriptions",
    ), "unknown", `${status} ${name}`);
    assert.equal(ambiguous.DGC_SITE_DB.value(
      "SELECT count(*) FROM form_cooldowns",
    ), 1, `${status} ${name}`);
  }

  const network = environment();
  resetEmail(async () => { throw new Error("network timeout"); });
  const timedOut = await worker.fetch(browserPost("/api/subscribe", urlencoded({
    email: "timeout@example.com", website: "",
  }), {ip: "203.0.113.52"}), network);
  assert.equal(timedOut.status, 503);
  assert.equal(network.DGC_SITE_DB.value("SELECT delivery_state FROM pending_subscriptions"), "unknown");
});

register("commercial delivery uses idempotency and records accepted/failed/ambiguous states", async () => {
  const fields = {
    name: "Ada Lovelace", email: "ada@example.com", company: "Analytical Engines",
    seats: "11–50", use_case: "We evaluate local coding models across a private monorepo.",
    website: "",
  };
  const accepted = environment();
  resetEmail();
  const success = await worker.fetch(browserPost("/api/commercial", urlencoded(fields), {
    ip: "203.0.113.60",
  }), accepted);
  assert.equal(success.status, 201);
  const lead = accepted.DGC_SITE_DB.rows("SELECT * FROM commercial_leads")[0];
  assert.equal(lead.delivery_state, "accepted");
  assert.equal(emailCalls[0].init.headers["idempotency-key"], lead.idempotency_key);
  assert.equal(emailCalls[0].body.reply_to, fields.email);
  assert.equal(emailCalls[0].body.to[0], accepted.DGC_CONTACT_EMAIL);

  const rejected = environment();
  resetEmail(async () => new Response(JSON.stringify({name: "validation_error"}), {
    status: 422, headers: {"content-type": "application/json"},
  }));
  assert.equal((await worker.fetch(browserPost("/api/commercial", urlencoded(fields), {
    ip: "203.0.113.61",
  }), rejected)).status, 503);
  assert.equal(rejected.DGC_SITE_DB.value("SELECT count(*) FROM commercial_leads"), 0);
  assert.equal(rejected.DGC_SITE_DB.value("SELECT count(*) FROM form_cooldowns"), 0);

  const ambiguous = environment();
  resetEmail(async () => { throw new Error("timeout"); });
  assert.equal((await worker.fetch(browserPost("/api/commercial", urlencoded(fields), {
    ip: "203.0.113.62",
  }), ambiguous)).status, 503);
  assert.equal(ambiguous.DGC_SITE_DB.value("SELECT delivery_state FROM commercial_leads"), "unknown");
  assert.equal(ambiguous.DGC_SITE_DB.value("SELECT count(*) FROM form_cooldowns"), 1);
});

register("commercial retries recover a post-send state-write failure without a new mail key", async () => {
  const fields = {
    name: "Grace Hopper", email: "grace@example.com", company: "Compiler Systems",
    seats: "51–200", use_case: "We need a reliable local-first coding harness for a regulated monorepo.",
    website: "",
  };
  const env = environment();
  const providerDeliveries = new Map();
  resetEmail(async call => {
    const key = call.init.headers["idempotency-key"];
    if (!providerDeliveries.has(key)) providerDeliveries.set(key, "email-recovery");
    return new Response(JSON.stringify({id: providerDeliveries.get(key)}), {
      status: 200, headers: {"content-type": "application/json"},
    });
  });
  env.DGC_SITE_DB.failNext("UPDATE commercial_leads SET delivery_state");

  const first = await worker.fetch(browserPost("/api/commercial", urlencoded(fields), {
    ip: "203.0.113.63",
  }), env);
  assert.equal(first.status, 201);
  assert.equal(emailCalls.length, 1);
  const stranded = env.DGC_SITE_DB.rows("SELECT * FROM commercial_leads")[0];
  assert.equal(stranded.delivery_state, "sending");
  const firstKey = emailCalls[0].init.headers["idempotency-key"];
  const firstBody = emailCalls[0].body;

  // Simulate the one-hour destination lease expiring while Resend's key is still
  // inside its 24-hour replay window.
  env.DGC_SITE_DB.sqlite.exec("DELETE FROM form_cooldowns");
  const retry = await worker.fetch(browserPost("/api/commercial", urlencoded(fields), {
    ip: "203.0.113.64",
  }), env);
  assert.equal(retry.status, 201);
  assert.equal(emailCalls.length, 2);
  assert.equal(emailCalls[1].init.headers["idempotency-key"], firstKey);
  assert.deepEqual(emailCalls[1].body, firstBody);
  assert.equal(providerDeliveries.size, 1);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM commercial_leads"), 1);
  const recovered = env.DGC_SITE_DB.rows("SELECT * FROM commercial_leads")[0];
  assert.equal(recovered.id, stranded.id);
  assert.equal(recovered.delivery_state, "accepted");
  assert.equal(recovered.resend_id, "email-recovery");
});

register("GET/HEAD actions do not touch D1; POST confirm and unsubscribe are explicit and idempotent", async () => {
  const env = environment();
  resetEmail();
  const subscribed = await worker.fetch(browserPost("/api/subscribe", urlencoded({
    email: "actions@example.com", website: "",
  }), {ip: "203.0.113.70"}), env);
  assert.equal(subscribed.status, 201);
  const pending = env.DGC_SITE_DB.rows("SELECT * FROM pending_subscriptions")[0];
  const beforeGet = env.DGC_SITE_DB.executions;

  const get = await worker.fetch(request("/api/subscribe/confirm?token=" + pending.token), env);
  assert.equal(get.status, 303);
  assert.equal(get.headers.get("location"), "/subscription#confirm=" + pending.token);
  assert.equal(get.headers.get("cache-control"), "no-store");
  assert.equal(get.headers.get("referrer-policy"), "no-referrer");
  assert.equal(env.DGC_SITE_DB.executions, beforeGet);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM subscribers"), 0);

  const head = await worker.fetch(request("/api/subscribe/confirm?token=" + pending.token, {
    method: "HEAD",
  }), env);
  assert.equal(head.status, 303);
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(head.headers.get("referrer-policy"), "no-referrer");
  assert.equal(env.DGC_SITE_DB.executions, beforeGet);

  const confirmed = await worker.fetch(browserPost("/api/subscribe/confirm", urlencoded({
    token: pending.token, website: "",
  }), {ip: "203.0.113.71"}), env);
  assert.equal(confirmed.status, 201);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM pending_subscriptions"), 0);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM subscribers"), 1);
  const subscriber = env.DGC_SITE_DB.rows("SELECT * FROM subscribers")[0];
  assert.notEqual(subscriber.unsubscribe_token, pending.token);
  assert.equal(subscriber.unsubscribe_token, pending.unsubscribe_token);

  const repeated = await worker.fetch(browserPost("/api/subscribe/confirm", urlencoded({
    token: pending.token, website: "",
  }), {ip: "203.0.113.72"}), env);
  assert.equal(repeated.status, 201);
  assert.equal(env.DGC_SITE_DB.value("SELECT unsubscribe_token FROM subscribers"), subscriber.unsubscribe_token);

  const beforeUnsubscribeGet = env.DGC_SITE_DB.executions;
  const unGet = await worker.fetch(request("/api/unsubscribe?token=" + subscriber.unsubscribe_token), env);
  assert.equal(unGet.status, 303);
  assert.equal(unGet.headers.get("location"), "/subscription#unsubscribe=" + subscriber.unsubscribe_token);
  assert.equal(unGet.headers.get("cache-control"), "no-store");
  assert.equal(unGet.headers.get("referrer-policy"), "no-referrer");
  assert.equal(env.DGC_SITE_DB.executions, beforeUnsubscribeGet);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM subscribers"), 1);

  const removed = await worker.fetch(browserPost("/api/unsubscribe", urlencoded({
    token: subscriber.unsubscribe_token, website: "",
  }), {ip: "203.0.113.73"}), env);
  assert.equal(removed.status, 201);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM subscribers"), 0);
  const removeAgain = await worker.fetch(browserPost("/api/unsubscribe", urlencoded({
    token: subscriber.unsubscribe_token, website: "",
  }), {ip: "203.0.113.74"}), env);
  assert.equal(removeAgain.status, 201);
});

register("action links remain non-mutating without bindings and invalid POSTs stay invalid", async () => {
  const noDb = environment({DGC_SITE_DB: null, DGC_RATE_LIMIT_SECRET: null});
  const token = "A".repeat(43);
  const landing = await worker.fetch(request("/api/unsubscribe?token=" + token), noDb);
  assert.equal(landing.status, 303);
  assert.equal(landing.headers.get("location"), "/subscription#unsubscribe=" + token);
  assert.equal(landing.headers.get("referrer-policy"), "no-referrer");
  const invalidLanding = await worker.fetch(request("/api/unsubscribe?token=bad"), noDb);
  assert.equal(invalidLanding.headers.get("location"), "/subscription#invalid");
  assert.equal(invalidLanding.headers.get("referrer-policy"), "no-referrer");

  const env = environment();
  const before = env.DGC_SITE_DB.executions;
  const invalid = await worker.fetch(browserPost("/api/subscribe/confirm", urlencoded({
    token: "bad", website: "",
  }), {ip: "203.0.113.80"}), env);
  assert.equal(invalid.status, 400);
  assert.equal(env.DGC_SITE_DB.executions, before);
  assertSecurity(invalid);
});

register("the emailed removal link can cancel a still-pending subscription", async () => {
  const env = environment();
  resetEmail();
  const subscribed = await worker.fetch(browserPost("/api/subscribe", urlencoded({
    email: "cancel-pending@example.com", website: "",
  }), {ip: "203.0.113.85"}), env);
  assert.equal(subscribed.status, 201);
  const pending = env.DGC_SITE_DB.rows("SELECT * FROM pending_subscriptions")[0];
  assert.match(emailCalls[0].body.text, new RegExp(
    "/api/unsubscribe\\?token="
      + pending.unsubscribe_token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ));

  const beforeGet = env.DGC_SITE_DB.executions;
  const landing = await worker.fetch(request(
    "/api/unsubscribe?token=" + pending.unsubscribe_token,
  ), env);
  assert.equal(landing.status, 303);
  assert.equal(env.DGC_SITE_DB.executions, beforeGet);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM pending_subscriptions"), 1);

  const removed = await worker.fetch(browserPost("/api/unsubscribe", urlencoded({
    token: pending.unsubscribe_token, website: "",
  }), {ip: "203.0.113.86"}), env);
  assert.equal(removed.status, 201);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM pending_subscriptions"), 0);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM subscribers"), 0);
});

register("confirmation batch rollback preserves pending consent", async () => {
  const env = environment();
  resetEmail();
  assert.equal((await worker.fetch(browserPost("/api/subscribe", urlencoded({
    email: "rollback@example.com", website: "",
  }), {ip: "203.0.113.90"}), env)).status, 201);
  const pending = env.DGC_SITE_DB.rows("SELECT * FROM pending_subscriptions")[0];
  env.DGC_SITE_DB.sqlite.exec([
    "CREATE TRIGGER fail_pending_delete BEFORE DELETE ON pending_subscriptions",
    "BEGIN SELECT RAISE(ABORT, 'forced rollback'); END",
  ].join(" "));
  const response = await worker.fetch(browserPost("/api/subscribe/confirm", urlencoded({
    token: pending.token, website: "",
  }), {ip: "203.0.113.91"}), env);
  assert.equal(response.status, 503);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM pending_subscriptions"), 1);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM subscribers"), 0);
});

register("background maintenance removes expired D1 rows", async () => {
  const env = environment();
  env.DGC_SITE_DB.sqlite.prepare([
    "INSERT INTO rate_limits(bucket_key,kind,window_id,count,expires_at)",
    "VALUES(?1,'test',1,1,1)",
  ].join(" ")).run("a".repeat(64));
  env.DGC_SITE_DB.sqlite.prepare([
    "INSERT INTO form_cooldowns(cooldown_key,kind,lease_id,expires_at)",
    "VALUES(?1,'test','lease',1)",
  ].join(" ")).run("b".repeat(64));
  env.DGC_SITE_DB.sqlite.prepare([
    "INSERT INTO pending_subscriptions",
    "(email_hash,email,token_hash,token,unsubscribe_token_hash,unsubscribe_token,",
    "source,created_at,expires_at,delivery_state,idempotency_key)",
    "VALUES(?1,'expired@example.com',?2,?3,?4,?5,'test',0,1,'pending','expired-pending')",
  ].join(" ")).run(
    "c".repeat(64), "d".repeat(64), "T".repeat(43), "e".repeat(64), "U".repeat(43),
  );
  env.DGC_SITE_DB.sqlite.prepare([
    "INSERT INTO commercial_leads",
    "(id,email_hash,submission_hash,name,email,company,seats,use_case,created_at,expires_at,delivery_state,idempotency_key)",
    "VALUES('expired-lead',?1,?2,'Test','lead@example.com','Company','1–10',",
    "'A sufficiently long use case.',0,1,'sending','expired-commercial')",
  ].join(" ")).run("f".repeat(64), "0".repeat(64));
  let maintenance;
  const response = await worker.fetch(request("/"), env, {
    waitUntil(promise) { maintenance = promise; },
  });
  assert.equal(response.status, 200);
  await maintenance;
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM rate_limits"), 0);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM form_cooldowns"), 0);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM pending_subscriptions"), 0);
  assert.equal(env.DGC_SITE_DB.value("SELECT count(*) FROM commercial_leads"), 0);
});

let failures = 0;
try {
  for (const {name, fn} of tests) {
    try {
      await fn();
      console.log("ok - " + name);
    } catch (error) {
      failures += 1;
      console.error("not ok - " + name);
      console.error(error?.stack || error);
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  for (const database of databases) database.close();
}

if (failures) {
  console.error(`worker regression gate failed: ${failures}/${tests.length} tests`);
  process.exitCode = 1;
} else {
  console.log(`worker regression gate passed: ${tests.length} tests`);
}
