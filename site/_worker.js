const EVENTS = new Set([
  "install_copy", "marketplace", "get_started", "docs_getting_started_reached",
  "capture_play", "benchmark_traces",
]);
const MEASUREMENT_ORIGINS = new Set([
  "https://vibedgc.com", "https://www.vibedgc.com", "https://docs.vibedgc.com",
]);
const PUBLIC_HOSTS = new Set(["vibedgc.com", "www.vibedgc.com", "docs.vibedgc.com"]);
const RETIRED_API_PATHS = new Set([
  "/api/commercial", "/api/subscribe", "/api/subscribe/confirm", "/api/unsubscribe",
]);
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};
let routeCache;

function harden(response, hostname = "") {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (name === "referrer-policy" && headers.get(name) === "no-referrer") continue;
    headers.set(name, value);
  }
  if (hostname.endsWith(".pages.dev")) headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  },
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
  if (!env.DGC_ANALYTICS || privacyOptOut(request)) return;
  try {
    const url = new URL(request.url);
    if (!MEASUREMENT_ORIGINS.has(url.origin)) return;
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

function validBrowserPost(request) {
  const url = new URL(request.url);
  return request.headers.get("origin") === url.origin
    && request.headers.get("sec-fetch-site") === "same-origin";
}

async function eventRoute(request, env) {
  if (request.method !== "POST"
      || !MEASUREMENT_ORIGINS.has(new URL(request.url).origin)
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
    measure(env, body.event, request, cleanPath(ref.pathname));
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestedPath = cleanPath(url.pathname);
    const hostname = url.hostname;
    const localDev = hostname === "127.0.0.1" || hostname === "localhost";
    let response;
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
      } else if (RETIRED_API_PATHS.has(url.pathname)) {
        response = json({error: "Not found"}, 404);
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
