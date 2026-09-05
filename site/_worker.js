const EVENTS = new Set([
  "install_copy", "marketplace", "get_started", "docs_getting_started_reached",
  "capture_play", "benchmark_traces",
]);
const FORM_ORIGINS = new Set([
  "https://vibedgc.com", "https://www.vibedgc.com", "https://docs.vibedgc.com",
]);
const PUBLIC_HOSTS = new Set(["vibedgc.com", "www.vibedgc.com", "docs.vibedgc.com"]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};
const RATE_UPSERT = [
  "INSERT INTO rate_limits (bucket_key, kind, window_id, count, expires_at)",
  "VALUES (?1, ?2, ?3, 1, ?4)",
  "ON CONFLICT(bucket_key) DO UPDATE SET",
  "kind = excluded.kind, window_id = excluded.window_id,",
  "count = CASE WHEN rate_limits.window_id < excluded.window_id THEN 1 ELSE rate_limits.count + 1 END,",
  "expires_at = MAX(rate_limits.expires_at, excluded.expires_at)",
  "WHERE rate_limits.window_id < excluded.window_id",
  "OR (rate_limits.window_id = excluded.window_id AND rate_limits.count < ?5)",
  "RETURNING count",
].join(" ");
const COOLDOWN_CLAIM = [
  "INSERT INTO form_cooldowns (cooldown_key, kind, lease_id, expires_at)",
  "VALUES (?1, ?2, ?3, ?4)",
  "ON CONFLICT(cooldown_key) DO UPDATE SET",
  "kind = excluded.kind, lease_id = excluded.lease_id, expires_at = excluded.expires_at",
  "WHERE form_cooldowns.expires_at <= ?5",
  "RETURNING lease_id",
].join(" ");
const PENDING_CLAIM = [
  "INSERT INTO pending_subscriptions",
  "(email_hash, email, token_hash, token, unsubscribe_token_hash, unsubscribe_token,",
  "source, created_at, expires_at, delivery_state, idempotency_key)",
  "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'site-footer', ?7, ?8, 'pending', ?9)",
  "ON CONFLICT(email_hash) DO UPDATE SET",
  "email = excluded.email, token_hash = excluded.token_hash, token = excluded.token,",
  "unsubscribe_token_hash = excluded.unsubscribe_token_hash,",
  "unsubscribe_token = excluded.unsubscribe_token,",
  "created_at = excluded.created_at, expires_at = excluded.expires_at,",
  "delivery_state = excluded.delivery_state, idempotency_key = excluded.idempotency_key, resend_id = NULL",
  "WHERE pending_subscriptions.expires_at <= ?7",
  "RETURNING token, token_hash, unsubscribe_token, unsubscribe_token_hash, idempotency_key",
].join(" ");
const CONFIRM_INSERT = [
  "INSERT INTO subscribers",
  "(email_hash, email, confirmation_token_hash, unsubscribe_token, unsubscribe_token_hash, confirmed_at, updated_at)",
  "SELECT email_hash, email, token_hash, unsubscribe_token, unsubscribe_token_hash, ?1, ?1",
  "FROM pending_subscriptions WHERE token_hash = ?2 AND expires_at > ?1",
  "ON CONFLICT(email_hash) DO UPDATE SET",
  "email = excluded.email, confirmation_token_hash = excluded.confirmation_token_hash,",
  "unsubscribe_token = excluded.unsubscribe_token,",
  "unsubscribe_token_hash = excluded.unsubscribe_token_hash,",
  "confirmed_at = excluded.confirmed_at, updated_at = excluded.updated_at",
].join(" ");
let routeCache;
let lastCleanup = 0;

function harden(response, hostname = "") {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (name === "referrer-policy" && headers.get(name) === "no-referrer") continue;
    headers.set(name, value);
  }
  if (hostname.endsWith(".pages.dev")) headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}

function applyResponsePolicy(response, pathname) {
  const headers = new Headers(response.headers);
  const existing = headers.get("cache-control") || "";
  if (!/\bno-store\b|\bno-cache\b/i.test(existing)) {
    if (pathname.startsWith("/assets/")) {
      headers.set("cache-control", "public, max-age=3600, must-revalidate");
    } else if (pathname.startsWith("/evidence/")) {
      headers.set("cache-control", "public, max-age=86400, immutable");
    } else if (/^\/vscode\/dgc-\d+\.\d+\.\d+\.vsix$/.test(pathname)) {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    } else if (isHtmlPath(pathname)
        || /\.(?:json|webmanifest|sha256)$/i.test(pathname)
        || ["/install.sh", "/dgc.tar.gz", "/vscode/dgc.vsix"].includes(pathname)) {
      headers.set("cache-control", "no-cache");
    } else if (/\.(?:png|jpe?g|svg|webm|mp4|woff2|zip)$/i.test(pathname)) {
      headers.set("cache-control", "public, max-age=3600, must-revalidate");
    }
  }
  if (pathname === "/install.sh") {
    headers.set("content-type", "text/plain; charset=utf-8");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), {
  status,
  headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra},
});

const redirect = (location, status = 303) => new Response(null, {
  status,
  headers: {location, "cache-control": "no-store", "referrer-policy": "no-referrer"},
});

function cleanPath(pathname) {
  let path = pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  if (path.length > 1) path = path.replace(/\/$/, "");
  return path || "/";
}

function isHtmlPath(pathname) {
  const lastSegment = pathname.split("/").pop() || "";
  return pathname.endsWith("/") || !lastSegment.includes(".") || lastSegment.endsWith(".html");
}

async function knownRoutes(env, origin) {
  if (!routeCache) {
    routeCache = env.ASSETS.fetch(new Request(new URL("/routes.json", origin))).then(async response => {
      if (!response.ok) throw new Error("routes.json unavailable");
      const data = await response.json();
      if (!Array.isArray(data.html) || data.html.some(path => typeof path !== "string")) {
        throw new Error("routes.json malformed");
      }
      return new Set(data.html.map(cleanPath));
    }).catch(error => {
      routeCache = undefined;
      throw error;
    });
  }
  return routeCache;
}

function uaClass(value) {
  if (/dgc-update-check/i.test(value)) return "dgc-update";
  if (/bot|crawler|spider|preview/i.test(value)) return "bot";
  if (/mobile|android|iphone/i.test(value)) return "mobile";
  return "desktop";
}

function privacyOptOut(request) {
  return request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1";
}

function measure(env, event, request, path = "") {
  if (env.DGC_ENVIRONMENT !== "production"
      || !env.DGC_ANALYTICS
      || privacyOptOut(request)) return;
  try {
    const url = new URL(request.url);
    if (!FORM_ORIGINS.has(url.origin)) return;
    env.DGC_ANALYTICS.writeDataPoint({
      indexes: [event],
      blobs: [url.hostname, path || url.pathname, uaClass(request.headers.get("user-agent") || "")],
      doubles: [1],
    });
  } catch {}
}

async function boundedBody(request, maxBytes) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
    throw new RangeError("Request is too large");
  }
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("Request is too large").catch(() => {});
      throw new RangeError("Request is too large");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

async function requestFields(request, maxBytes = 16_384) {
  const rawType = request.headers.get("content-type") || "";
  const type = rawType.toLowerCase();
  if (!["application/json", "application/x-www-form-urlencoded", "multipart/form-data"]
    .some(value => type.startsWith(value))) {
    throw new TypeError("Unsupported form encoding");
  }
  const body = await boundedBody(request, maxBytes);
  if (type.startsWith("application/json")) {
    const value = JSON.parse(new TextDecoder().decode(body));
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new TypeError("Invalid form");
    }
    if (Object.values(value).some(item => typeof item !== "string")) {
      throw new TypeError("Invalid form");
    }
    return value;
  }
  const copy = new Request(request.url, {
    method: "POST",
    headers: {"content-type": rawType},
    body,
  });
  const form = await copy.formData();
  const value = {};
  for (const [name, item] of form.entries()) {
    if (typeof item !== "string") throw new TypeError("Files are not accepted");
    value[name] = item;
  }
  return value;
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function d1Ready(env) {
  return Boolean(env.DGC_SITE_DB
    && typeof env.DGC_SITE_DB.prepare === "function"
    && typeof env.DGC_SITE_DB.batch === "function");
}

async function cleanupExpired(env) {
  const nowMs = Date.now();
  if (!d1Ready(env) || nowMs - lastCleanup < 900_000) return;
  lastCleanup = nowMs;
  const now = Math.floor(nowMs / 1000);
  try {
    await env.DGC_SITE_DB.batch([
      env.DGC_SITE_DB.prepare("DELETE FROM rate_limits WHERE expires_at <= ?1").bind(now),
      env.DGC_SITE_DB.prepare("DELETE FROM form_cooldowns WHERE expires_at <= ?1").bind(now),
      env.DGC_SITE_DB.prepare("DELETE FROM pending_subscriptions WHERE expires_at <= ?1").bind(now),
      // Retain expiry cleanup for compatibility with the original schema. Intake is retired.
      env.DGC_SITE_DB.prepare("DELETE FROM commercial_leads WHERE expires_at <= ?1").bind(now),
    ]);
  } catch {
    lastCleanup = 0;
  }
}

async function keyedDigest(secret, scope, value) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new TypeError("Rate-limit secret unavailable");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {name: "HMAC", hash: "SHA-256"},
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(scope + "\u0000" + value),
  );
  return [...new Uint8Array(signature)]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function permitted(request, env, name, limit) {
  if (!d1Ready(env) || !env.DGC_RATE_LIMIT_SECRET) {
    return {allowed: false, unavailable: true};
  }
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) return {allowed: false, unavailable: true};
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / 3600) * 3600;
  try {
    const key = await keyedDigest(env.DGC_RATE_LIMIT_SECRET, "rate:" + name, ip);
    const result = await env.DGC_SITE_DB.prepare(RATE_UPSERT).bind(
      key, name, windowStart, windowStart + 7200, limit,
    ).first();
    if (!result) return {allowed: false, unavailable: false};
    const count = Number(result.count);
    if (!Number.isFinite(count)) throw new Error("Rate counter unavailable");
    return {allowed: count <= limit, unavailable: false};
  } catch {
    return {allowed: false, unavailable: true};
  }
}

async function destinationCooldown(env, name, value, seconds) {
  if (!d1Ready(env) || !env.DGC_RATE_LIMIT_SECRET) {
    return {allowed: false, unavailable: true, key: "", lease: ""};
  }
  const now = Math.floor(Date.now() / 1000);
  const expires = now + seconds;
  const lease = crypto.randomUUID();
  try {
    const key = await keyedDigest(env.DGC_RATE_LIMIT_SECRET, "cooldown:" + name, value);
    const result = await env.DGC_SITE_DB.prepare(COOLDOWN_CLAIM).bind(
      key, name, lease, expires, now,
    ).first();
    if (!result) return {allowed: false, unavailable: false, key, lease: ""};
    return {allowed: result.lease_id === lease, unavailable: false, key, lease};
  } catch {
    return {allowed: false, unavailable: true, key: "", lease: ""};
  }
}

async function releaseCooldown(env, key, lease) {
  if (!key || !lease || !d1Ready(env)) return;
  await env.DGC_SITE_DB.prepare(
    "DELETE FROM form_cooldowns WHERE cooldown_key = ?1 AND lease_id = ?2",
  ).bind(key, lease).run();
}

function formEnvironmentReady(request, env) {
  return env.DGC_ENVIRONMENT === "production"
    && FORM_ORIGINS.has(new URL(request.url).origin)
    && d1Ready(env)
    && typeof env.DGC_RATE_LIMIT_SECRET === "string"
    && env.DGC_RATE_LIMIT_SECRET.length >= 32;
}

function validBrowserPost(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return origin === url.origin && (!fetchSite || fetchSite === "same-origin");
}

function oneLine(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

function validEmail(value) {
  return value.length <= 254 && EMAIL_PATTERN.test(value) && !/[<>,;\s]/.test(value);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-")
    .replace(/\//g, "_").replace(/=+$/, "");
}

async function sendEmail(env, {to, subject, text, idempotencyKey}) {
  if (!env.RESEND_API_KEY || !env.DGC_FROM_EMAIL || !to) {
    return {ok: false, ambiguous: false, id: ""};
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.RESEND_API_KEY,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        from: env.DGC_FROM_EMAIL,
        to: [to],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const result = await response.json().catch(() => ({}));
    const retryableConflict = response.status === 409
      && ["concurrent_idempotent_requests", "resource_locked"].includes(result?.name);
    const uncertainProviderFailure = response.status >= 500;
    return {
      ok: response.ok,
      ambiguous: retryableConflict || uncertainProviderFailure,
      id: typeof result.id === "string" ? result.id : "",
    };
  } catch {
    return {ok: false, ambiguous: true, id: ""};
  }
}

function formSuccess(request, value, location) {
  if ((request.headers.get("accept") || "").includes("application/json")) {
    return json(value, 201);
  }
  return redirect(location);
}

function formError(message, status) {
  return json({error: message}, status);
}

async function subscribeRoute(request, env, email, cooldown) {
  const now = Math.floor(Date.now() / 1000);
  const emailHash = await digest(email);
  const proposedToken = randomToken();
  const proposedHash = await digest(proposedToken);
  const proposedUnsubscribe = randomToken();
  const proposedUnsubscribeHash = await digest(proposedUnsubscribe);
  const proposedKey = "dgc-release-" + proposedHash;
  let pending;
  try {
    pending = await env.DGC_SITE_DB.prepare(PENDING_CLAIM).bind(
      emailHash, email, proposedHash, proposedToken,
      proposedUnsubscribeHash, proposedUnsubscribe,
      now, now + 172800, proposedKey,
    ).first();
    if (!pending) {
      pending = await env.DGC_SITE_DB.prepare([
        "SELECT token, token_hash, unsubscribe_token, unsubscribe_token_hash,",
        "idempotency_key FROM pending_subscriptions",
        "WHERE email_hash = ?1 AND expires_at > ?2 LIMIT 1",
      ].join(" ")).bind(emailHash, now).first();
    }
    if (!pending?.token || !pending?.token_hash
        || !pending?.unsubscribe_token || !pending?.unsubscribe_token_hash
        || !pending?.idempotency_key) {
      throw new Error("pending request unavailable");
    }
  } catch {
    await releaseCooldown(env, cooldown.key, cooldown.lease).catch(() => {});
    return formError("Subscriptions are temporarily unavailable", 503);
  }

  const confirm = "https://vibedgc.com/api/subscribe/confirm?token="
    + encodeURIComponent(pending.token);
  const remove = "https://vibedgc.com/api/unsubscribe?token="
    + encodeURIComponent(pending.unsubscribe_token);
  const sent = await sendEmail(env, {
    to: email,
    subject: "Confirm DGC release notes",
    idempotencyKey: pending.idempotency_key,
    text: "Confirm your DGC release-notes subscription:\n\n" + confirm
      + "\n\nThe confirmation link expires in 48 hours and opens a page where you must "
      + "explicitly confirm.\n\nCancel this request or unsubscribe later:\n\n" + remove
      + "\n\nIf you did not request it, you can ignore this message or use the removal link.",
  });
  try {
    const state = sent.ok ? "accepted" : sent.ambiguous ? "unknown" : "pending";
    await env.DGC_SITE_DB.prepare([
      "UPDATE pending_subscriptions SET delivery_state = ?1, resend_id = ?2",
      "WHERE token_hash = ?3",
    ].join(" ")).bind(state, sent.id || null, pending.token_hash).run();
  } catch {}
  if (!sent.ok) {
    if (!sent.ambiguous) {
      await env.DGC_SITE_DB.prepare(
        "DELETE FROM pending_subscriptions WHERE token_hash = ?1",
      ).bind(pending.token_hash).run().catch(() => {});
      await releaseCooldown(env, cooldown.key, cooldown.lease).catch(() => {});
    }
    return formError(
      sent.ambiguous
        ? "Confirmation status is uncertain; wait a moment and check your inbox"
        : "Confirmation email could not be sent",
      503,
    );
  }
  measure(env, "release_subscribe_requested", request, "/api/subscribe");
  return formSuccess(
    request,
    {message: "Check your inbox to confirm."},
    "/?subscription=pending#release-notes",
  );
}

async function subscribeRequestRoute(request, env) {
  if (request.method !== "POST") {
    return json({error: "Method not allowed"}, 405, {allow: "POST"});
  }
  if (!formEnvironmentReady(request, env)) {
    return formError("Subscriptions are unavailable in this environment", 503);
  }
  if (!validBrowserPost(request)) return formError("Origin rejected", 403);
  let fields;
  try {
    fields = await requestFields(request);
  } catch (error) {
    return formError(
      error instanceof RangeError ? "Form is too large" : "Invalid form",
      error instanceof RangeError ? 413 : 400,
    );
  }
  if (oneLine(fields.website, 200)) {
    return formSuccess(request, {message: "Received. Thank you."}, "/");
  }

  const email = String(fields.email || "").trim().toLowerCase();
  if (!validEmail(email)) return formError("Enter a valid email", 400);
  const rate = await permitted(request, env, "subscribe", 6);
  if (!rate.allowed) {
    return formError(
      rate.unavailable ? "Subscriptions are temporarily unavailable" : "Too many requests",
      rate.unavailable ? 503 : 429,
    );
  }
  const cooldown = await destinationCooldown(
    env, "subscribe", email, 900,
  );
  if (!cooldown.allowed) {
    return formError(
      cooldown.unavailable
        ? "Subscriptions are temporarily unavailable"
        : "Please wait before submitting this address again",
      cooldown.unavailable ? 503 : 429,
    );
  }
  return subscribeRoute(request, env, email, cooldown);
}

async function subscriptionAction(request, env, action) {
  if (request.method === "GET" || request.method === "HEAD") {
    const token = new URL(request.url).searchParams.get("token") || "";
    const fragment = TOKEN_PATTERN.test(token)
      ? action + "=" + encodeURIComponent(token)
      : "invalid";
    return redirect("/subscription#" + fragment);
  }
  if (request.method !== "POST") {
    return json({error: "Method not allowed"}, 405, {allow: "GET, POST"});
  }
  if (!formEnvironmentReady(request, env)) {
    return formError("Subscriptions are unavailable in this environment", 503);
  }
  if (!validBrowserPost(request)) return formError("Origin rejected", 403);
  let fields;
  try {
    fields = await requestFields(request, 2_048);
  } catch (error) {
    return formError(
      error instanceof RangeError ? "Form is too large" : "Invalid request",
      error instanceof RangeError ? 413 : 400,
    );
  }
  if (oneLine(fields.website, 200)) {
    return formSuccess(request, {message: "Done."}, "/subscription?status=complete");
  }
  const token = oneLine(fields.token, 80);
  if (!TOKEN_PATTERN.test(token)) {
    return formError("That subscription link is invalid or expired", 400);
  }
  const rate = await permitted(request, env, action, 12);
  if (!rate.allowed) {
    return formError(
      rate.unavailable
        ? "Subscriptions are temporarily unavailable"
        : "Too many requests",
      rate.unavailable ? 503 : 429,
    );
  }
  const tokenHash = await digest(token);

  if (action === "confirm") {
    const now = Math.floor(Date.now() / 1000);
    try {
      const results = await env.DGC_SITE_DB.batch([
        env.DGC_SITE_DB.prepare(CONFIRM_INSERT).bind(now, tokenHash),
        env.DGC_SITE_DB.prepare(
          "DELETE FROM pending_subscriptions WHERE token_hash = ?1",
        ).bind(tokenHash),
      ]);
      const changed = Number(results?.[0]?.meta?.changes || 0);
      if (!changed) {
        const confirmed = await env.DGC_SITE_DB.prepare([
          "SELECT 1 AS found FROM subscribers",
          "WHERE confirmation_token_hash = ?1 LIMIT 1",
        ].join(" ")).bind(tokenHash).first();
        if (!confirmed) {
          return formError("That subscription link is invalid or expired", 400);
        }
      }
    } catch {
      return formError("Subscriptions are temporarily unavailable", 503);
    }
    measure(env, "release_subscribe_confirmed", request, "/api/subscribe/confirm");
    return formSuccess(
      request,
      {message: "Subscription confirmed."},
      "/subscription?status=confirmed",
    );
  }

  try {
    await env.DGC_SITE_DB.batch([
      env.DGC_SITE_DB.prepare(
        "DELETE FROM subscribers WHERE unsubscribe_token_hash = ?1",
      ).bind(tokenHash),
      env.DGC_SITE_DB.prepare(
        "DELETE FROM pending_subscriptions WHERE unsubscribe_token_hash = ?1",
      ).bind(tokenHash),
    ]);
  } catch {
    return formError("Subscriptions are temporarily unavailable", 503);
  }
  return formSuccess(
    request,
    {message: "You have been unsubscribed."},
    "/subscription?status=removed",
  );
}

async function eventRoute(request, env) {
  if (request.method !== "POST"
      || env.DGC_ENVIRONMENT !== "production"
      || !FORM_ORIGINS.has(new URL(request.url).origin)
      || privacyOptOut(request)
      || !validBrowserPost(request)) {
    return new Response(null, {status: 204});
  }
  if (!(request.headers.get("content-type") || "")
    .toLowerCase().startsWith("application/json")) {
    return new Response(null, {status: 204});
  }
  try {
    const bodyBytes = await boundedBody(request, 1_024);
    const body = JSON.parse(new TextDecoder().decode(bodyBytes));
    const referrer = request.headers.get("referer");
    const ref = referrer ? new URL(referrer) : null;
    if (!ref
        || ref.origin !== new URL(request.url).origin
        || !EVENTS.has(body.event)) {
      return new Response(null, {status: 204});
    }
    const rate = await permitted(request, env, "event", 120);
    if (rate.allowed) {
      measure(env, body.event, request, cleanPath(ref.pathname));
    }
  } catch {}
  return new Response(null, {status: 204});
}

async function notFound(env, url, docs = false) {
  const path = docs ? "/docs/404.html" : "/404.html";
  const response = await env.ASSETS.fetch(new Request(
    new URL(path, url),
    {headers: {accept: "text/html"}},
  ));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache");
  return new Response(response.body, {status: 404, headers});
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const requestedPath = cleanPath(url.pathname);
    const hostname = url.hostname;
    const localDev = env.DGC_ENVIRONMENT !== "production"
      && (hostname === "127.0.0.1" || hostname === "localhost");
    let response;
    if (ctx?.waitUntil
        && env.DGC_ENVIRONMENT === "production"
        && FORM_ORIGINS.has(url.origin)) {
      ctx.waitUntil(cleanupExpired(env));
    }
    try {
      if (!localDev && hostname === "www.vibedgc.com") {
        url.protocol = "https:";
        url.hostname = "vibedgc.com";
        url.port = "";
        response = redirect(url.toString(), 301);
      } else if (!localDev
          && PUBLIC_HOSTS.has(hostname)
          && url.protocol !== "https:") {
        url.protocol = "https:";
        url.port = "";
        response = redirect(url.toString(), 301);
      } else if (!localDev
          && !PUBLIC_HOSTS.has(hostname)
          && !/\.pages\.dev$/i.test(hostname)) {
        url.protocol = "https:";
        url.hostname = "vibedgc.com";
        url.port = "";
        response = redirect(url.toString(), 301);
      } else if (url.pathname === "/api/event") {
        response = await eventRoute(request, env);
      } else if (url.pathname === "/api/commercial") {
        response = json({error: "Not found"}, 404);
      } else if (url.pathname === "/api/subscribe") {
        response = await subscribeRequestRoute(request, env);
      } else if (url.pathname === "/api/subscribe/confirm") {
        response = await subscriptionAction(request, env, "confirm");
      } else if (url.pathname === "/api/unsubscribe") {
        response = await subscriptionAction(request, env, "unsubscribe");
      } else {
        const docsHost = /^docs\.vibedgc\.com$/i.test(hostname);
        const htmlPath = ["GET", "HEAD"].includes(request.method)
          && isHtmlPath(url.pathname);
        const routes = htmlPath ? await knownRoutes(env, url.origin) : null;
        if (docsHost) {
          if (url.pathname === "/") {
            url.pathname = "/docs/";
          } else if (!url.pathname.startsWith("/docs")
              && routes?.has(cleanPath("/docs" + url.pathname))) {
            url.pathname = "/docs" + url.pathname;
          } else if (htmlPath && routes?.has(cleanPath(url.pathname))) {
            const target = new URL(request.url);
            target.hostname = "vibedgc.com";
            target.port = "";
            response = redirect(target.toString(), 301);
          }
        }
        if (htmlPath
            && !response
            && !routes.has(cleanPath(url.pathname))) {
          response = await notFound(env, url, docsHost);
        }
        if (!response) {
          response = await env.ASSETS.fetch(new Request(url.toString(), request));
          const location = response.headers.get("location");
          if (docsHost && location) {
            const target = new URL(location, url);
            if (target.origin === url.origin && target.pathname.startsWith("/docs")) {
              target.pathname = target.pathname.slice(5) || "/";
            }
            const headers = new Headers(response.headers);
            headers.set("location", target.toString());
            response = new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          }
          if (request.method === "GET"
              && ["/install.sh", "/dgc.tar.gz"].includes(url.pathname)) {
            measure(env, "download", request, url.pathname);
          }
        }
      }
    } catch {
      response = json({error: "Service temporarily unavailable"}, 503);
    }
    if (request.method === "GET"
        && [200, 304].includes(response.status)
        && isHtmlPath(new URL(request.url).pathname)) {
      measure(env, "page_view", request, requestedPath);
    }
    return harden(applyResponsePolicy(response, new URL(request.url).pathname), hostname);
  },
};
