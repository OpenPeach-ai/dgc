import {expect, test} from "@playwright/test";

import {observeRuntime, readTransferReport, ROUTES, settle, VIEWPORT_BUDGETS} from "./support.mjs";

for (const route of ROUTES) {
  test(`${route} renders without browser regressions`, async ({page}, testInfo) => {
    const runtime = observeRuntime(page);
    const response = await page.goto(route, {waitUntil: "domcontentloaded"});
    expect(response?.status(), `${route} should resolve through the generated route map`).toBe(200);
    await settle(page);

    const pageFacts = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      hasHeading: Boolean(document.querySelector("h1")),
      hasMain: Boolean(document.querySelector("main")),
      headingWeights: [...document.querySelectorAll("h1,h2,h3,h4")]
        .map(heading => Number.parseInt(getComputedStyle(heading).fontWeight, 10)),
      language: document.documentElement.lang,
      scrollWidth: document.documentElement.scrollWidth,
      title: document.title.trim(),
    }));
    expect(pageFacts.title, `${route} needs a document title`).not.toBe("");
    expect(pageFacts.language).toBe("en");
    expect(pageFacts.hasHeading, `${route} needs one visible page heading`).toBe(true);
    expect(pageFacts.hasMain, `${route} needs a main landmark`).toBe(true);
    expect(
      pageFacts.headingWeights.every(weight => Number.isFinite(weight) && weight <= 500),
      `${route} renders a heading above weight 500: ${pageFacts.headingWeights.join(", ")}`,
    ).toBe(true);
    expect(
      pageFacts.scrollWidth,
      `${route} overflows horizontally at ${pageFacts.clientWidth}px`,
    ).toBeLessThanOrEqual(pageFacts.clientWidth + 1);
    expect(runtime.consoleErrors, `${route} logged console errors`).toEqual([]);
    expect(runtime.pageErrors, `${route} raised uncaught page errors`).toEqual([]);
    expect(runtime.httpErrors, `${route} requested failing local resources`).toEqual([]);

    const budget = VIEWPORT_BUDGETS[testInfo.project.name];
    if (budget) {
      const transfer = await readTransferReport(page);
      expect(
        transfer.bytes,
        `${route} initial local transfer exceeded ${Math.round(budget / 1000)} KB\n${transfer.entries.map(entry => `${entry.name}: ${entry.bytes} B`).join("\n")}`,
      ).toBeLessThanOrEqual(budget);
    }
  });
}
