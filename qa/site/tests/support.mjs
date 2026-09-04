import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const ROUTES = Object.freeze(
  JSON.parse(readFileSync(resolve(ROOT, "site/routes.json"), "utf8")).html,
);

export const VIEWPORT_BUDGETS = Object.freeze({
  "chromium-mobile-390": 600_000,
  "chromium-desktop-1440": 900_000,
});

export function routeLabel(route) {
  return route === "/" ? "home" : route.slice(1).replaceAll("/", "--");
}

export function observeRuntime(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const httpErrors = [];

  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin !== "http://127.0.0.1:4173") return;
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${url.pathname}`);
  });
  return {
    consoleErrors,
    pageErrors,
    httpErrors,
  };
}

export async function readTransferReport(page) {
  return page.evaluate(() => {
    const entries = [
      ...performance.getEntriesByType("navigation"),
      ...performance.getEntriesByType("resource"),
    ];
    const local = entries
      .filter(entry => new URL(entry.name).origin === location.origin)
      .map(entry => ({
        bytes: Math.round(entry.transferSize),
        name: `${entry.initiatorType || entry.entryType} ${new URL(entry.name).pathname}`,
      }))
      .sort((left, right) => right.bytes - left.bytes);
    return {
      bytes: local.reduce((sum, entry) => sum + entry.bytes, 0),
      entries: local,
    };
  });
}

export async function settle(page) {
  await page.waitForLoadState("load");
  // The landing page keeps below-fold CSS off the render-critical path until
  // intent to continue. Exercise that public event before inspecting the full
  // document; Lighthouse intentionally measures the untouched first viewport.
  await page.evaluate(() => window.dispatchEvent(new Event("dgc:load-styles")));
  await page.waitForFunction(() => !document.documentElement.classList.contains("defer-styles"));
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(350);
}
