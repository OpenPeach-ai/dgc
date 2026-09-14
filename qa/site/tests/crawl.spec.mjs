import {expect, test} from "@playwright/test";

import {ROUTES} from "./support.mjs";

// Crawler-facing files through the QA server. No screenshots and no baselines: these read bytes.
const SITEMAP_URL = "https://vibedgc.com/sitemap.xml";

function localPath(loc) {
  const url = new URL(loc);
  if (url.hostname === "docs.vibedgc.com") return `/docs${url.pathname === "/" ? "" : url.pathname}`;
  expect(url.hostname, loc).toBe("vibedgc.com");
  return url.pathname;
}

async function pageFacts(request, path) {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  const source = await response.text();
  return {
    canonicals: [...source.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map(match => match[1]),
    noindex: /<meta\s+name="robots"\s+content="[^"]*\b(?:noindex|none)\b/i.test(source),
  };
}

async function sitemapLocs(request) {
  const response = await request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^application\/xml\b/);
  const source = await response.text();
  expect(source).not.toMatch(/<(?:lastmod|changefreq|priority)\b/);
  return [...source.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
}

test("robots.txt is plain text, allows crawling and names the sitemap", async ({request}) => {
  const response = await request.get("/robots.txt");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^text\/plain\b/);
  const body = await response.text();
  expect(body).toMatch(new RegExp(`^Sitemap: ${SITEMAP_URL.replaceAll(".", "\\.")}$`, "m"));
  expect(body).toMatch(/^User-agent: \*$/m);
  expect(body).not.toMatch(/^Disallow:\s*\/\s*$/m);
});

test("every sitemap URL is a live, indexable page whose canonical is that URL", async ({request}) => {
  const locs = await sitemapLocs(request);
  expect(new Set(locs).size, "duplicate <loc>").toBe(locs.length);
  expect(locs.length).toBe(ROUTES.length);
  for (const loc of locs) {
    const facts = await pageFacts(request, localPath(loc));
    expect(facts.canonicals, loc).toEqual([loc]);
    expect(facts.noindex, loc).toBe(false);
  }
});

test("every routed page's canonical is listed and the not-found pages are not", async ({request}) => {
  const listed = new Set(await sitemapLocs(request));
  for (const route of ROUTES) {
    const facts = await pageFacts(request, route);
    expect(facts.canonicals.length, route).toBe(1);
    expect(listed.has(facts.canonicals[0]), `${route} -> ${facts.canonicals[0]}`).toBe(true);
  }
  for (const path of ["/404", "/docs/404"]) {
    const facts = await pageFacts(request, path);
    expect(facts.noindex, path).toBe(true);
    expect(listed.has(facts.canonicals[0]), path).toBe(false);
  }
});
