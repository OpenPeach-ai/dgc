#!/usr/bin/env node

import {spawn} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "@playwright/test";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const executable = chromium.executablePath();
const lighthouse = resolve(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "lighthouse.cmd" : "lighthouse",
);
const allRoutes = process.argv.includes("--all-routes");
const routes = JSON.parse(readFileSync(resolve(ROOT, "site", "routes.json"), "utf8")).html;
const representativeRoutes = ["/", "/benchmark", "/vscode"];
const routeLabel = route => route === "/" ? "home" : route.slice(1).replaceAll("/", "--");
const targets = (allRoutes ? routes : representativeRoutes).map(route => [routeLabel(route), route]);
// Match the three visual-acceptance viewports. Tablet deliberately keeps mobile
// scoring/throttling: it exercises the responsive breakpoint under the stricter
// performance model instead of becoming a second desktop-shaped audit.
const profiles = [
  {name: "desktop", lcpLimit: 1000, args: [
    "--preset=desktop",
    "--screenEmulation.mobile=false",
    "--screenEmulation.width=1440",
    "--screenEmulation.height=1000",
    "--screenEmulation.deviceScaleFactor=1",
  ]},
  {name: "tablet", lcpLimit: 2000, args: [
    "--form-factor=mobile",
    "--screenEmulation.mobile=true",
    "--screenEmulation.width=768",
    "--screenEmulation.height=1024",
    "--screenEmulation.deviceScaleFactor=1",
  ]},
  {name: "mobile", lcpLimit: 2000, args: [
    "--form-factor=mobile",
    "--screenEmulation.mobile=true",
    "--screenEmulation.width=390",
    "--screenEmulation.height=844",
    "--screenEmulation.deviceScaleFactor=1",
  ]},
];
const limits = {
  performance: 0.95,
  accessibility: 0.98,
  lcp: {desktop: 1000, tablet: 2000, mobile: 2000},
  cls: 0,
};
const scope = allRoutes ? "all-routes" : "representative";

if (!existsSync(executable)) {
  process.stderr.write("Pinned Chromium is missing. Run: npx playwright install chromium\n");
  process.exit(2);
}
if (!existsSync(lighthouse)) {
  process.stderr.write("Pinned Lighthouse is missing. Run: npm ci\n");
  process.exit(2);
}

function waitForServer(child) {
  return new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error("site QA server did not become ready")), 15_000);
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`site QA server exited early (${code})`)));
    child.stdout.on("data", chunk => {
      const message = chunk.toString();
      process.stdout.write(message);
      const match = message.match(/DGC site QA server ready at http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      accept(Number(match[1]));
    });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
  });
}

function run(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: {...process.env, CHROME_PATH: executable},
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)));
  });
}

const server = spawn(process.execPath, ["qa/site/server.mjs", "--port", "0"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});

let failed = false;
const summary = [];
try {
  const port = await waitForServer(server);
  const origin = `http://127.0.0.1:${port}`;
  for (const profile of profiles) {
    const directory = resolve(ROOT, "output", "site-qa", "lighthouse", scope, profile.name);
    mkdirSync(directory, {recursive: true});
    for (const [name, route] of targets) {
      const output = resolve(directory, name);
      const args = [
        `${origin}${route}`,
        "--only-categories=performance,accessibility",
        "--output=json",
        "--output=html",
        `--output-path=${output}`,
        "--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage",
        "--max-wait-for-load=45000",
        "--quiet",
      ];
      args.push(...profile.args);
      process.stdout.write(`Lighthouse ${profile.name}: ${route}\n`);
      await run(lighthouse, args);

      const report = JSON.parse(readFileSync(`${output}.report.json`, "utf8"));
      const result = {
        profile: profile.name,
        route,
        performance: report.categories.performance.score,
        accessibility: report.categories.accessibility.score,
        lcp: report.audits["largest-contentful-paint"].numericValue,
        cls: report.audits["cumulative-layout-shift"].numericValue,
      };
      summary.push(result);
      const failures = [];
      if (result.performance < limits.performance) failures.push(`performance ${result.performance}`);
      if (result.accessibility < limits.accessibility) failures.push(`accessibility ${result.accessibility}`);
      if (result.lcp > profile.lcpLimit) failures.push(`LCP ${Math.round(result.lcp)} ms`);
      if (result.cls !== limits.cls) failures.push(`CLS ${result.cls.toFixed(6)}`);
      if (failures.length) {
        failed = true;
        process.stderr.write(`FAIL ${profile.name} ${route}: ${failures.join(", ")}\n`);
      } else {
        process.stdout.write(`PASS ${profile.name} ${route}: perf ${result.performance}, a11y ${result.accessibility}, LCP ${Math.round(result.lcp)} ms, CLS ${result.cls.toFixed(3)}\n`);
      }
    }
  }
  const summaryPath = resolve(ROOT, "output", "site-qa", "lighthouse", scope, "summary.json");
  writeFileSync(summaryPath, `${JSON.stringify({scope, limits, results: summary}, null, 2)}\n`);
} finally {
  server.kill("SIGTERM");
}

if (failed) process.exit(1);
