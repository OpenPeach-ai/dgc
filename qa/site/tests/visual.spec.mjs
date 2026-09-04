import {expect, test} from "@playwright/test";

import {routeLabel, settle} from "./support.mjs";

const REPRESENTATIVE_ROUTES = [
  "/",
  "/benchmark",
  "/vscode",
  "/docs",
  "/pricing",
  "/blog/benchmark-methodology",
];

for (const route of REPRESENTATIVE_ROUTES) {
  test(`${route} matches the reviewed visual baseline`, async ({page}) => {
    // Capture a deterministic, content-complete state; motion behavior has its
    // own functional coverage in reduced-motion.spec.mjs and interactions.spec.mjs.
    await page.emulateMedia({reducedMotion: "reduce"});
    await page.goto(route, {waitUntil: "domcontentloaded"});
    await settle(page);
    // Chromium full-page capture does not paint off-screen content skipped by
    // content-visibility:auto. Force paint only in this capture context so the
    // baseline contains every real section instead of intrinsic-size blanks.
    await page.addStyleTag({
      content: "main > .section, main > .quote-band { content-visibility: visible !important; contain-intrinsic-size: none !important; }",
    });
    await page.evaluate(() => document.documentElement.scrollHeight);
    await page.waitForTimeout(100);
    await page.evaluate(() => scrollTo(0, 0));
    await expect(page).toHaveScreenshot(`${routeLabel(route)}.png`, {fullPage: true});
  });
}
