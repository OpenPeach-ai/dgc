import {expect, test} from "@playwright/test";

async function observeEvents(page) {
  const requests = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() !== "POST" || url.pathname !== "/api/event") return;
    requests.push(url.pathname);
  });
  await page.addInitScript(() => {
    window.__analyticsBeacons = [];
    const sendBeacon = navigator.sendBeacon.bind(navigator);
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value(url, data) {
        const record = {body: null, url: new URL(url, location.href).pathname};
        window.__analyticsBeacons.push(record);
        Promise.resolve(data instanceof Blob ? data.text() : String(data || ""))
          .then(body => { record.body = JSON.parse(body); });
        return sendBeacon(url, data);
      },
    });
  });
  return {
    read: () => page.evaluate(() => window.__analyticsBeacons),
    requests,
  };
}

test("docs getting-started emits one reach event", async ({page}) => {
  const telemetry = await observeEvents(page);
  await page.goto("/docs/getting-started", {waitUntil: "load"});

  await expect.poll(telemetry.read).toEqual([{
    body: {event: "docs_getting_started_reached", path: "/docs/getting-started"},
    url: "/api/event",
  }]);
  expect(telemetry.requests).toEqual(["/api/event"]);
});

for (const privacySignal of ["DNT", "GPC"]) {
  test(`docs reach honors ${privacySignal}`, async ({page}) => {
    await page.addInitScript(signal => {
      if (signal === "DNT") {
        Object.defineProperty(navigator, "doNotTrack", {configurable: true, value: "1"});
      } else {
        Object.defineProperty(navigator, "globalPrivacyControl", {configurable: true, value: true});
      }
    }, privacySignal);
    const telemetry = await observeEvents(page);
    await page.goto("/docs/getting-started", {waitUntil: "load"});

    const observedSignal = await page.evaluate(signal => signal === "DNT"
      ? navigator.doNotTrack
      : navigator.globalPrivacyControl, privacySignal);
    expect(observedSignal).toBe(privacySignal === "DNT" ? "1" : true);
    expect(await page.locator("[data-page-event=docs_getting_started_reached]").count()).toBe(1);
    await page.waitForTimeout(200);
    expect(await telemetry.read()).toEqual([]);
    expect(telemetry.requests).toEqual([]);
  });
}

test("install copy event is emitted only after clipboard success", async ({page}) => {
  await page.addInitScript(() => {
    window.__clipboardMode = "reject";
    window.__clipboardWrites = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(value) {
          window.__clipboardWrites.push(value);
          return window.__clipboardMode === "resolve"
            ? Promise.resolve()
            : Promise.reject(new Error("Clipboard denied by analytics test"));
        },
      },
    });
  });
  const telemetry = await observeEvents(page);
  await page.goto("/", {waitUntil: "load"});
  const copy = page.locator("[data-copy][data-event=install_copy]");

  await copy.click();
  await expect(copy).toHaveText("select");
  expect(await telemetry.read()).toEqual([]);
  expect(telemetry.requests).toEqual([]);

  await page.evaluate(() => { window.__clipboardMode = "resolve"; });
  await copy.click();
  await expect(copy).toHaveText("copied");
  await expect.poll(telemetry.read).toEqual([{
    body: {event: "install_copy", path: "/"},
    url: "/api/event",
  }]);
  expect(telemetry.requests).toEqual(["/api/event"]);
  await expect.poll(() => page.evaluate(() => window.__clipboardWrites)).toEqual([
    "curl -fsSL https://vibedgc.com/install.sh | bash",
    "curl -fsSL https://vibedgc.com/install.sh | bash",
  ]);
});
