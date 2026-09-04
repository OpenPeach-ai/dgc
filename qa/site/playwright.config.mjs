import {defineConfig} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export default defineConfig({
  testDir: resolve(ROOT, "qa/site/tests"),
  outputDir: resolve(ROOT, "output/site-qa/test-results"),
  snapshotPathTemplate: resolve(ROOT, "qa/site/baselines/{projectName}/{arg}{ext}"),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Fixed concurrency keeps media-heavy visual checks reproducible on large
  // shared runners instead of letting host CPU count distort timing and CLS.
  workers: 2,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.005,
      scale: "css",
      threshold: 0.2,
    },
  },
  reporter: [
    ["line"],
    ["html", {open: "never", outputFolder: resolve(ROOT, "output/site-qa/playwright-report")}],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    colorScheme: "dark",
    deviceScaleFactor: 1,
    locale: "en-US",
    reducedMotion: "no-preference",
    serviceWorkers: "block",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node qa/site/server.mjs --port 4173",
    cwd: ROOT,
    reuseExistingServer: false,
    timeout: 15_000,
    url: "http://127.0.0.1:4173/__qa/ready",
  },
  projects: [
    {
      name: "chromium-mobile-390",
      grepInvert: /@reduced/,
      use: {viewport: {width: 390, height: 844}},
    },
    {
      name: "chromium-tablet-768",
      grepInvert: /@reduced/,
      use: {viewport: {width: 768, height: 1024}},
    },
    {
      name: "chromium-desktop-1440",
      grepInvert: /@reduced/,
      use: {viewport: {width: 1440, height: 1000}},
    },
    {
      name: "chromium-reduced-motion-mobile-390",
      grep: /@reduced/,
      use: {reducedMotion: "reduce", viewport: {width: 390, height: 844}},
    },
    {
      name: "chromium-reduced-motion-desktop-1440",
      grep: /@reduced/,
      use: {reducedMotion: "reduce", viewport: {width: 1440, height: 1000}},
    },
  ],
});
