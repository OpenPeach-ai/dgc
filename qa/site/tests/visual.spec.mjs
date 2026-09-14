import {existsSync, readdirSync, rmSync} from "node:fs";
import {dirname, join} from "node:path";

import {expect, test} from "@playwright/test";

import {routeLabel, settle} from "./support.mjs";

// A visual difference is either a regression or a nondeterminism bug; a retry would hide both.
test.describe.configure({retries: 0});

const REPRESENTATIVE_ROUTES = [
  "/",
  "/benchmark",
  "/vscode",
  "/docs",
  "/pricing",
  "/changelog",
];

// Chrome that every route shares is compared as pixels once, on the home page, so a release
// that only changes the version string fails 3 small images rather than 18. Every route still
// records its geometry.
const SHARED_CHROME = new Set(["announcement", "footer"]);

// Text-bearing leaves. A grid cell's box does not move when its padding changes; the block-level
// value and label inside it do — that is how the 18px hero-stats step went unseen.
const GEOMETRY_LEAVES = [
  "h1", "h2", "h3", "h4", "p", "li", "pre", "table", "figure", "blockquote",
  "img", "video", "canvas", "button", "input", "a.button",
  ".eyebrow", ".stat-value", ".stat-label", ".card",
].join(",");

async function prepare(page, route) {
  // Capture a deterministic, content-complete state; motion behavior has its own functional
  // coverage in reduced-motion.spec.mjs and interactions.spec.mjs. With motion allowed, the WebGL
  // mesh, the scripted demos and the footer differ run to run by thousands of pixels.
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto(route, {waitUntil: "domcontentloaded"});
  await settle(page);
  if (route === "/") {
    // CSS animation disabling does not freeze a WebGL RAF loop. Wait for the reduced-motion
    // frame (or its no-WebGL fallback) before capture.
    await page.waitForFunction(() => ["static", "fallback"].includes(
      document.querySelector("canvas[data-hero-mesh]")?.dataset.meshState,
    ));
  }
  // content-visibility:auto sections are neither painted by a full-page capture nor measured at
  // their real height: their boxes report contain-intrinsic-size until they have rendered once.
  // Geometry is measured after this, so it never depends on what happened to scroll into view.
  await page.addStyleTag({
    content: "main > .section, main > .quote-band { content-visibility: visible !important; contain-intrinsic-size: none !important; }",
  });
  // The editor preview (home and /vscode) is deferred until it enters the viewport; a full-page
  // capture never scrolls, so without this the home baseline records an empty black box.
  const preview = page.locator("video[data-editor-preview]");
  if (await preview.count()) {
    await preview.scrollIntoViewIfNeeded();
    await expect(preview).toHaveAttribute("data-hydrated", "true");
    await expect.poll(() => preview.evaluate(video =>
      performance.getEntriesByName(video.poster).some(entry => entry.responseEnd > 0),
    )).toBe(true);
  }
  // Sections that were skipped can request faces and images after document.fonts.ready resolved.
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map(face => face.load().catch(() => {})));
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    scrollTo(0, 0);
  });
}

function measure(page) {
  return page.evaluate(leafSelector => {
    const round = value => Math.round(value * 100) / 100;
    const box = element => {
      const rect = element.getBoundingClientRect();
      return {x: rect.left + scrollX, y: rect.top + scrollY, w: rect.width, h: rect.height};
    };
    const visible = element => element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== "hidden";
    const firstClass = element => typeof element.className === "string"
      ? element.className.trim().split(/\s+/)[0] || "" : "";

    // Band names are file names: stable across unrelated insertions when the section has an id,
    // ordinal otherwise. No "#" — it breaks attachment links in the HTML report.
    const ordinals = new Map();
    const regionKey = element => {
      const tag = element.tagName.toLowerCase();
      if (element.id) return `${tag}-${element.id}`;
      const base = [tag, firstClass(element)].filter(Boolean).join("-");
      const n = (ordinals.get(base) || 0) + 1;
      ordinals.set(base, n);
      return `${base}-${n}`;
    };
    const regions = [];
    const announcement = document.querySelector("body > .announcement");
    if (announcement && visible(announcement)) regions.push({key: "announcement", element: announcement});
    const header = document.querySelector("body > .site-header");
    if (header) regions.push({key: "header", element: header});
    for (const element of document.querySelector("main").children) {
      if (visible(element)) regions.push({key: regionKey(element), element});
    }
    const footer = document.querySelector("body > footer");
    if (footer) regions.push({key: "footer", element: footer});

    const docWidth = document.documentElement.scrollWidth;
    const docHeight = document.documentElement.scrollHeight;
    // Contiguous full-width bands from one region's top to the next one's: every pixel of the
    // page belongs to exactly one band, and a change in one section's height fails that band
    // alone instead of shifting every capture below it.
    const bands = regions.map((region, index) => {
      const top = Math.round(box(region.element).y);
      const next = regions[index + 1];
      const bottom = next ? Math.round(box(next.element).y) : docHeight;
      return {key: region.key, top, height: bottom - top};
    });

    // Leaves are relative to their region, so a height change upstream moves one region line in
    // the diff, not every line below it.
    const lines = [`document ${docWidth}x${docHeight}`];
    for (const region of regions) {
      const origin = box(region.element);
      lines.push(`${region.key} @${[origin.x, origin.y, origin.w, origin.h].map(round).join(",")}`);
      const seen = new Map();
      for (const leaf of region.element.querySelectorAll(leafSelector)) {
        if (!visible(leaf)) continue;
        const name = [leaf.tagName.toLowerCase(), firstClass(leaf)].filter(Boolean).join(".");
        const n = seen.get(name) || 0;
        seen.set(name, n + 1);
        const rect = box(leaf);
        lines.push(`  ${name}[${n}] ${round(rect.x - origin.x)},${round(rect.y - origin.y)} ${round(rect.w)}x${round(rect.h)}`);
      }
    }
    return {bands, docWidth, geometry: `${lines.join("\n")}\n`};
  }, GEOMETRY_LEAVES);
}

for (const route of REPRESENTATIVE_ROUTES) {
  test(`${route} matches the reviewed visual baseline, section by section`, async ({page}, testInfo) => {
    // Each band is its own stable capture; the tall pages need more than the 30s default.
    test.setTimeout(90_000);
    const label = routeLabel(route);
    await prepare(page, route);
    const {bands, docWidth, geometry} = await measure(page);

    // Exact: a 1px move of any landmark or text leaf fails, and the diff names the element.
    expect.soft(geometry, `${label}: landmark and text geometry`).toMatchSnapshot([label, "geometry.txt"]);

    const produced = new Set(["geometry.txt"]);
    for (const band of bands) {
      if (route !== "/" && SHARED_CHROME.has(band.key)) continue;
      produced.add(`${band.key}.png`);
      await expect.soft(page, `${label}: ${band.key}`).toHaveScreenshot([label, `${band.key}.png`], {
        fullPage: true,
        clip: {x: 0, y: band.top, width: docWidth, height: band.height},
      });
    }

    // Playwright never deletes a baseline, so a renamed or removed section would leave a stale
    // image that nothing compares. Updates prune them; ordinary runs fail on them.
    const directory = dirname(testInfo.snapshotPath(label, "geometry.txt"));
    const orphans = existsSync(directory) ? readdirSync(directory).filter(file => !produced.has(file)) : [];
    if (["all", "changed"].includes(testInfo.config.updateSnapshots)) {
      for (const file of orphans) rmSync(join(directory, file));
    } else {
      expect.soft(orphans, `${label}: baselines that no section produces`).toEqual([]);
    }
  });
}
