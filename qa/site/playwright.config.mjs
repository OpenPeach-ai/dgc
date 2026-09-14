import {defineConfig} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {QA_ORIGIN, QA_PORT} from "./origin.mjs";

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
  // CI never writes a baseline: a missing one fails. Locally a missing one is written for review.
  updateSnapshots: process.env.CI ? "none" : "missing",
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      // Absolute, per section band (visual.spec.mjs). Local run-to-run noise is 0 px; a 1px shift
      // of one text box is 100+ px and the smallest real change measured (one version string) 43.
      // A ratio budget scaled with page height and let whole-section regressions through.
      maxDiffPixels: 10,
      scale: "css",
      threshold: 0.05,
    },
  },
  reporter: [
    ["line"],
    ["html", {open: "never", outputFolder: resolve(ROOT, "output/site-qa/playwright-report")}],
  ],
  use: {
    baseURL: QA_ORIGIN,
    browserName: "chromium",
    colorScheme: "light",
    deviceScaleFactor: 1,
    locale: "en-US",
    reducedMotion: "no-preference",
    serviceWorkers: "block",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node qa/site/server.mjs --port ${QA_PORT}`,
    cwd: ROOT,
    reuseExistingServer: false,
    timeout: 15_000,
    url: `${QA_ORIGIN}/__qa/ready`,
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
