import {expect, test} from "@playwright/test";

import {observeRuntime, settle} from "./support.mjs";

const ACTION_TOKEN = "qa-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789";

async function formContract(form) {
  return form.evaluate(element => ({
    action: new URL(element.action).pathname,
    fields: [...element.elements]
      .filter(field => field.name)
      .map(field => field.name)
      .sort(),
    method: element.method.toLowerCase(),
  }));
}

test("pricing explains the commercial boundary without collecting enquiries", async ({page}) => {
  const runtime = observeRuntime(page);
  await page.goto("/pricing", {waitUntil: "domcontentloaded"});
  await settle(page);

  await expect(page.locator('form[action*="commercial"]')).toHaveCount(0);
  await expect(page.getByRole("heading", {name: "Not offered through this site."})).toBeVisible();
  await expect(page.getByText("No sales or licensing enquiry form is operated here")).toBeVisible();
  await expect(page.getByRole("link", {name: "Read the license ↗"})).toHaveAttribute(
    "href", "https://github.com/OpenPeach-ai/dgc/blob/main/LICENSE",
  );
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("release-notes form uses the subscribe contract and surfaces API errors", async ({page}) => {
  await page.goto("/about", {waitUntil: "domcontentloaded"});
  await settle(page);

  const form = page.locator("#release-notes");
  expect(await formContract(form)).toEqual({
    action: "/api/subscribe",
    fields: ["email", "website"],
    method: "post",
  });
  const email = form.locator('[name="email"]');
  await email.fill("reader@example.com");
  await form.getByRole("button", {name: "Subscribe"}).click();
  await expect(form.locator(".form-status")).toHaveText("Check your inbox to confirm.");
  await expect(email).toHaveValue("");
  await expect(form.getByRole("button", {name: "Subscribe"})).toBeEnabled();

  await page.route("**/api/subscribe", route => route.fulfill({
    body: JSON.stringify({error: "Too many requests"}),
    contentType: "application/json",
    status: 429,
  }));
  await email.fill("reader@example.com");
  await form.getByRole("button", {name: "Subscribe"}).click();
  await expect(form.locator(".form-status")).toHaveText(
    "Too many requests. Please try again.",
  );
  await expect(email).toHaveValue("reader@example.com");
  await expect(form.getByRole("button", {name: "Subscribe"})).toBeEnabled();
});

for (const action of [
  {
    fragment: "confirm",
    endpoint: "/api/subscribe/confirm",
    button: "Confirm subscription",
    message: "Subscription confirmed.",
  },
  {
    fragment: "unsubscribe",
    endpoint: "/api/unsubscribe",
    button: "Unsubscribe",
    message: "You have been unsubscribed.",
  },
]) {
  test(`${action.fragment} review binds the private token to an explicit POST`, async ({page}) => {
    await page.goto(`/subscription#${action.fragment}=${ACTION_TOKEN}`, {
      waitUntil: "domcontentloaded",
    });
    await settle(page);

    const form = page.locator("form[data-subscription-action]");
    await expect(form).toBeVisible();
    expect(await formContract(form)).toEqual({
      action: action.endpoint,
      fields: ["token", "website"],
      method: "post",
    });
    await expect(form.locator('[name="token"]')).toHaveValue(ACTION_TOKEN);
    expect(new URL(page.url()).hash).toBe("");

    const sent = page.waitForRequest(request => (
      request.method() === "POST" && new URL(request.url()).pathname === action.endpoint
    ));
    await form.getByRole("button", {name: action.button}).click();
    const request = await sent;
    expect(request.postData() || "").toContain(ACTION_TOKEN);
    await expect(form.locator(".form-status")).toHaveText(action.message);
    await expect(page.locator("[data-subscription-title]")).toHaveText(action.message);
    await expect(form.getByRole("button", {name: action.button})).toBeDisabled();
  });
}

test("QA server rejects unknown API POST routes", async ({request}) => {
  const response = await request.post("/api/not-a-site-endpoint", {
    data: {message: "must not false-pass"},
  });
  expect(response.status()).toBe(404);
  expect(await response.json()).toEqual({error: "Unknown QA API endpoint"});
});
