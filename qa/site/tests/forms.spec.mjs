import {expect, test} from "@playwright/test";

import {observeRuntime, settle} from "./support.mjs";

test("pricing states the licence and collects nothing", async ({page}) => {
  const runtime = observeRuntime(page);
  await page.goto("/pricing", {waitUntil: "domcontentloaded"});
  await settle(page);

  await expect(page.locator("form")).toHaveCount(0);
  // Apache 2.0 removed the commercial boundary this page used to be built around: there is no
  // separate licence to ask for, so the page has nothing to collect and says so by saying nothing.
  await expect(page.getByRole("heading", {name: "Nothing changes at work."})).toBeVisible();
  await expect(page.getByText("Commercial use included, no agreement needed")).toBeVisible();
  await expect(page.getByRole("link", {name: "Read the license ↗"})).toHaveAttribute(
    "href", "https://github.com/OpenPeach-ai/dgc/blob/main/LICENSE",
  );
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("footer keeps its navigation without an email or contact form", async ({page}) => {
  const runtime = observeRuntime(page);
  await page.goto("/about", {waitUntil: "domcontentloaded"});
  await settle(page);

  const footer = page.locator("footer.site-footer");
  await expect(footer).toBeVisible();
  await expect(footer.locator("form")).toHaveCount(0);
  await expect(footer.getByRole("link", {name: "DGC home"})).toHaveAttribute(
    "href", "https://vibedgc.com/",
  );
  for (const name of ["Product", "Learn", "Project", "Legal"]) {
    await expect(footer.getByRole("navigation", {name})).toBeVisible();
  }
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("release signup and blog publishing surfaces stay retired", async ({request}) => {
  for (const path of ["/subscription", "/subscription.html"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
  for (const path of [
    "/api/event", "/api/commercial", "/api/subscribe", "/api/subscribe/confirm",
    "/api/unsubscribe",
  ]) {
    const response = await request.post(path, {data: {email: "reader@example.com"}});
    expect(response.status(), path).toBe(404);
    expect(await response.json(), path).toEqual({error: "Unknown QA API endpoint"});
  }
  for (const path of [
    "/blog", "/blog/", "/blog.html", "/blog/index.html",
    "/blog/benchmark-methodology", "/blog/benchmark-methodology.html",
    "/blog/permission-model", "/blog/permission-model.html",
    "/blog/the-harness-is-the-product", "/blog/the-harness-is-the-product.html",
    "/feed.xml",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
});

test("QA server rejects unknown API POST routes", async ({request}) => {
  const response = await request.post("/api/not-a-site-endpoint", {
    data: {message: "must not false-pass"},
  });
  expect(response.status()).toBe(404);
  expect(await response.json()).toEqual({error: "Unknown QA API endpoint"});
});
