#!/usr/bin/env node
/**
 * Look at the REAL extension, in REAL VS Code, under Xvfb.
 *
 * My Chromium harness renders main.js and main.css against the panel's own skeleton, which is close
 * but is not the shipping surface: it has no VS Code theme variables, no extension host, and no
 * real panel geometry. The slash menu collapsing to one clipped row is exactly the class of defect
 * that harness cannot see -- it was a flex-shrink fight with the workbench's own layout.
 *
 * So this loads the packaged VSIX into a disposable profile, opens the DGC panel, drives its
 * webview with Playwright over CDP, and photographs what is actually on screen.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const VSIX = process.env.DGC_VSIX || "/tmp/vsix-out/dgc-0.31.0-selfhost.vsix";
const OUT = process.env.DGC_SHOT_DIR
  || "/tmp/claude-1000/-home-fungigb10-evolving-fungi/149af3bd-5e8e-428b-b4a6-1892f29a8dfc/scratchpad";
const VIEWPORT = { width: 1280, height: 860 };
const DISPLAY = ":" + (90 + Math.floor(process.pid % 9));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 25_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(what);
}

const workspace = mkdtempSync(join(tmpdir(), "dgc-real-ws-"));
const userData = mkdtempSync(join(tmpdir(), "dgc-real-ud-"));
const extensions = mkdtempSync(join(tmpdir(), "dgc-real-ext-"));
let xvfb, code, browser;

function cleanup() {
  try { browser?.close(); } catch { /* already gone */ }
  for (const child of [code, xvfb]) {
    try { if (child?.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  for (const dir of [workspace, userData, extensions]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
process.on("exit", cleanup);

try {
  if (!existsSync(VSIX)) throw new Error(`no VSIX at ${VSIX}`);
  // `xvfb-run -a` picks a free display itself -- this machine has a dozen orphaned X sockets from
  // earlier runs, and choosing one by hand collided with them. `/usr/share/code/code` is the
  // Electron binary; `/usr/bin/code` is a wrapper that can hand off to an existing instance and
  // then exposes no debugging target of its own, which is why CDP saw zero pages.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];

  // Unpack the VSIX rather than shelling out to `code --install-extension`: that call hangs here
  // (it wants a window it never gets), and unpacking is exactly what an install does -- it is how
  // this same build reaches the founder's Cursor.
  const staging = join(extensions, ".staging");
  const unzip = spawnSync("unzip", ["-q", VSIX, "-d", staging], { encoding: "utf8" });
  if (unzip.status !== 0) throw new Error(`unzip failed: ${unzip.stderr}`);
  spawnSync("mv", [join(staging, "extension"), join(extensions, "vibedgc.dgc-0.31.0")]);
  spawnSync("rm", ["-rf", staging]);
  if (!existsSync(join(extensions, "vibedgc.dgc-0.31.0", "package.json"))) {
    throw new Error("the unpacked VSIX has no package.json");
  }
  console.log("unpacked the packaged VSIX into a disposable extensions dir");

  const port = 9000 + (process.pid % 900);
  code = spawn("xvfb-run", ["-a", "-s", `-screen 0 ${VIEWPORT.width}x${VIEWPORT.height}x24`,
    "/usr/share/code/code",
    `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
    `--remote-debugging-port=${port}`,
    "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking",
    "--disable-updates", "--disable-telemetry", "--disable-crash-reporter",
    "--disable-extension-gallery", "--use-inmemory-secretstorage", "--no-sandbox",
    "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", "--new-window",
    workspace,
  ], { cwd: workspace, env, detached: true, stdio: "ignore" });

  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null))?.ok,
                "VS Code did not expose its debugging target");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  // VS Code's first window under Xvfb on this machine takes longer than the default wait, and a
  // failure that only says "no workbench window" tells me nothing -- so say what CDP DID see.
  let seen = [];
  const page = await waitFor(async () => {
    seen = [];
    for (const candidate of browser.contexts().flatMap((c) => c.pages())) {
      try {
        seen.push(candidate.url().slice(0, 80));
        if (await candidate.locator(".monaco-workbench").count()) return candidate;
      } catch { /* provisional Electron target */ }
    }
    return null;
  }, `no workbench window; CDP targets were: ${JSON.stringify(seen)}`, 90_000);
  console.log("workbench is up");

  // Open the DGC panel the way a person does.
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(700);
  await page.keyboard.type("DGC: Open Chat");
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");

  const frame = await waitFor(async () => {
    for (const f of page.frames()) {
      try { if (await f.locator("#input").count()) return f; } catch { /* detaching */ }
    }
    return null;
  }, "the DGC webview never loaded", 60_000);
  console.log("the real DGC webview is loaded");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/real-vscode-panel.png` });

  // THE CHECK: type "/" and measure what the menu actually does on the real surface.
  await frame.locator("#input").click();
  await page.keyboard.type("/");
  await page.waitForTimeout(900);
  const menu = await frame.evaluate(() => {
    const pop = document.getElementById("pop");
    const box = pop.getBoundingClientRect();
    const rows = [...pop.querySelectorAll(".pi")];
    const whole = rows.filter((n) => {
      const r = n.getBoundingClientRect();
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    });
    const cbox = document.getElementById("cbox").getBoundingClientRect();
    return {
      popHeight: Math.round(box.height),
      rowCount: rows.length,
      fullyVisibleRows: whole.length,
      firstRow: rows[0]?.querySelector(".pi-label")?.textContent.trim() || null,
      firstRowIcon: rows[0]?.querySelector(".pi-icon")
        ? [...rows[0].querySelector(".pi-icon").classList].find((c) => c.startsWith("codicon-")) : null,
      composerVisible: cbox.height > 0,
      popAboveComposer: box.bottom <= cbox.top + 2,
    };
  });
  console.log("SLASH MENU ON THE REAL SURFACE:", JSON.stringify(menu, null, 1));
  await page.screenshot({ path: `${OUT}/real-vscode-slash.png` });

  // THE OTHER CHECK: picking `goal` must arm the prompt, not open a dialog.
  await frame.locator("#input").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("finish the sub-agent stages /goa");
  await page.waitForTimeout(700);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(700);
  const armed = await frame.evaluate(() => ({
    dialogOpen: !document.getElementById("goal-editor").hidden,
    pills: [...document.querySelectorAll("#input [data-pill]")]
      .map((p) => ({ kind: p.dataset.kind, shown: p.textContent, wire: p.dataset.pill })),
    value: document.getElementById("input").value,
  }));
  console.log("GOAL PICK ON THE REAL SURFACE:", JSON.stringify(armed, null, 1));
  await page.screenshot({ path: `${OUT}/real-vscode-goal-armed.png` });

  // Narrow it to one match -- the case that used to collapse the list to a single line.
  await frame.locator("#input").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("/");
  await page.waitForTimeout(700);
  await page.keyboard.type("goal");
  await page.waitForTimeout(700);
  const narrowed = await frame.evaluate(() => {
    const pop = document.getElementById("pop");
    return { popHeight: Math.round(pop.getBoundingClientRect().height),
             rowCount: pop.querySelectorAll(".pi").length };
  });
  console.log("NARROWED TO ONE MATCH:", JSON.stringify(narrowed));
  await page.screenshot({ path: `${OUT}/real-vscode-slash-narrow.png` });
  console.log("OK");
} catch (error) {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
}
