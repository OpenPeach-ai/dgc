#!/usr/bin/env node

import assert from "node:assert/strict";

import worker from "../site/_worker.js";

const tests = [];
const ROUTES = [
  "/", "/benchmark", "/vscode",
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

const sharedAssets = new AssetsMock({failRoutes: 1});

function environment(overrides = {}) {
  const bindings = {
    ASSETS: overrides.ASSETS || sharedAssets,
  };
  return new Proxy(bindings, {
    get(target, property, receiver) {
      if (typeof property === "string" && !Reflect.has(target, property)) {
        throw new Error(`unexpected dynamic Worker binding: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function request(path, {base = "https://vibedgc.com", method = "GET", headers = {}, body} = {}) {
  const init = {method, headers: new Headers(headers)};
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = "half";
  }
  return new Request(new URL(path, base), init);
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
    const head = await worker.fetch(request(path, {
      method: "HEAD", headers: {accept: "text/html,*/*"},
    }), env);
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
  const missing = await worker.fetch(request("/not-a-route", {
    headers: {accept: "text/html"},
  }), env);
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
  const insecure = await worker.fetch(request("/benchmark", {
    base: "http://vibedgc.com:8080",
  }), env);
  assert.equal(insecure.headers.get("location"), "https://vibedgc.com/benchmark");

  const preview = await worker.fetch(request("/", {base: "https://build.pages.dev"}), env);
  assert.equal(preview.status, 200);
  assertSecurity(preview, {preview: true});
});

register("retired dynamic and publishing paths are stateless 404s", async () => {
  const paths = [
    "/api/event", "/api/commercial", "/api/subscribe", "/api/subscribe/confirm",
    "/api/unsubscribe",
  ];
  for (const path of paths) {
    for (const method of ["GET", "POST"]) {
      const env = environment();
      const response = await worker.fetch(request(path, {
        method,
        headers: method === "POST" ? {"content-type": "application/json"} : {},
        body: method === "POST" ? JSON.stringify({email: "person@example.com"}) : undefined,
      }), env);
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), {error: "Not found"}, `${method} ${path}`);
      assert.equal(response.headers.get("cache-control"), "no-store", `${method} ${path}`);
      assertSecurity(response);
    }
  }
  for (const path of ["/subscription", "/subscription.html"]) {
    const response = await worker.fetch(request(path, {headers: {accept: "text/html"}}), environment());
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), "MAIN_404", path);
  }
  for (const path of [
    "/blog", "/blog/", "/blog.html", "/blog/index.html",
    "/blog/benchmark-methodology", "/blog/benchmark-methodology.html",
    "/blog/permission-model", "/blog/permission-model.html",
    "/blog/the-harness-is-the-product", "/blog/the-harness-is-the-product.html",
  ]) {
    const env = environment();
    const response = await worker.fetch(request(path, {headers: {accept: "text/html"}}), env);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), "MAIN_404", path);
    assertSecurity(response);
  }
  const feedEnv = environment();
  const feed = await worker.fetch(request("/feed.xml"), feedEnv);
  assert.equal(feed.status, 404);
  assertSecurity(feed);
});

let failures = 0;
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

if (failures) {
  console.error(`worker regression gate failed: ${failures}/${tests.length} tests`);
  process.exitCode = 1;
} else {
  console.log(`worker regression gate passed: ${tests.length} tests`);
}
