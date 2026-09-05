import {expect, test} from "@playwright/test";

import {observeRuntime, settle} from "./support.mjs";

test("eager hero video stays visible when cache-warm reload playback precedes initialization", async ({page}) => {
  const runtime = observeRuntime(page);
  const heroState = () => page.locator("video[data-hero-video]").evaluate(video => ({
    autoplay: video.autoplay,
    currentSrc: new URL(video.currentSrc).pathname,
    paused: video.paused,
    preload: video.preload,
    ready: video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
    visible: video.parentElement?.classList.contains("video-ready") === true,
  }));
  const expectedSource = (page.viewportSize()?.width || 0) <= 800
    ? "/assets/hero-mobile.webm"
    : "/assets/hero-graded.webm";

  await page.goto("/", {waitUntil: "load"});
  await expect.poll(heroState).toEqual({
    autoplay: true,
    currentSrc: expectedSource,
    paused: false,
    preload: "auto",
    ready: true,
    visible: true,
  });

  let releaseScript;
  let signalScriptRequest;
  const scriptHeld = new Promise(resolve => { releaseScript = resolve; });
  const scriptRequested = new Promise(resolve => { signalScriptRequest = resolve; });
  await page.route("**/assets/site.js?*", async route => {
    signalScriptRequest();
    await scriptHeld;
    await route.continue();
  });

  const reload = page.reload({waitUntil: "load"});
  let earlyFailure;
  try {
    await scriptRequested;
    await expect.poll(async () => {
      const state = await heroState();
      return {paused: state.paused, ready: state.ready};
    }).toEqual({paused: false, ready: true});
    expect((await heroState()).visible).toBe(false);
  } catch (error) {
    earlyFailure = error;
  } finally {
    releaseScript();
  }
  await reload;
  if (earlyFailure) throw earlyFailure;

  await expect.poll(heroState).toEqual({
    autoplay: true,
    currentSrc: expectedSource,
    paused: false,
    preload: "auto",
    ready: true,
    visible: true,
  });
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("first pointer intent initializes home controls before its click", async ({page}) => {
  const runtime = observeRuntime(page);
  await page.goto("/", {waitUntil: "domcontentloaded"});

  const opener = page.locator('[data-open-capture="product-capture"]').first();
  const capture = page.locator("#product-capture");
  await opener.click();
  await expect(capture).toHaveAttribute("open", "");
  await capture.locator("[data-close-capture]").click();
  await expect(capture).not.toHaveAttribute("open", "");

  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("first click-only activation initializes home controls in capture phase", async ({page}) => {
  const runtime = observeRuntime(page);
  await page.goto("/", {waitUntil: "domcontentloaded"});

  const capture = page.locator("#product-capture");
  await page.locator('[data-open-capture="product-capture"]').first().evaluate(element => element.click());
  await expect(capture).toHaveAttribute("open", "");
  await capture.locator("[data-close-capture]").evaluate(element => element.click());
  await expect(capture).not.toHaveAttribute("open", "");

  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("install copy handles clipboard failure and preserves exact command bytes", async ({page}) => {
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
            : Promise.reject(new Error("Clipboard denied by interaction test"));
        },
      },
    });
  });
  const runtime = observeRuntime(page);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);

  const copy = page.locator('[data-copy][data-copy-target="#hero-install"]');
  await copy.click();
  await expect(copy).toHaveText("select");

  await page.evaluate(() => { window.__clipboardMode = "resolve"; });
  await copy.click();
  await expect(copy).toHaveText("copied");
  await expect.poll(() => page.evaluate(() => window.__clipboardWrites)).toEqual([
    "curl -fsSL https://vibedgc.com/install.sh | bash",
    "curl -fsSL https://vibedgc.com/install.sh | bash",
  ]);

  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("a returning visitor's dismissed announcement does not shift layout", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  const announcementVersion = await page.locator("[data-announcement]").getAttribute("data-announcement");
  expect(announcementVersion).toBeTruthy();
  await page.evaluate(version => {
    localStorage.setItem(`dgc-announcement-${version}`, "dismissed");
  }, announcementVersion);
  await page.addInitScript(() => {
    window.__dgcLayoutShifts = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          window.__dgcLayoutShifts.push({
            value: entry.value,
            sources: entry.sources.map(source => source.node?.outerHTML?.slice(0, 240) || "unknown"),
          });
        }
      }
    }).observe({type: "layout-shift", buffered: true});
  });
  await page.reload({waitUntil: "load"});
  await expect(page.locator("[data-announcement]")).toBeHidden();
  await page.waitForTimeout(3800);
  const shifts = await page.evaluate(() => window.__dgcLayoutShifts);
  expect(shifts, JSON.stringify(shifts, null, 2)).toEqual([]);
});

test("the sticky header spans the viewport while its controls stay container-aligned", async ({page}) => {
  const runtime = observeRuntime(page);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);

  const geometry = await page.evaluate(() => {
    const header = document.querySelector(".site-header").getBoundingClientRect();
    const container = document.querySelector("main .container").getBoundingClientRect();
    const brand = document.querySelector(".site-header .brand").getBoundingClientRect();
    const candidates = [...document.querySelectorAll(".site-header .nav-install,.site-header .nav-toggle")];
    const trailing = candidates.find(element => getComputedStyle(element).display !== "none")
      .getBoundingClientRect();
    return {
      brandLeft: brand.left,
      clientWidth: document.documentElement.clientWidth,
      containerLeft: container.left,
      containerRight: container.right,
      headerLeft: header.left,
      headerRight: header.right,
      trailingRight: trailing.right,
    };
  });
  expect(Math.abs(geometry.headerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.headerRight - geometry.clientWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.brandLeft - geometry.containerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.trailingRight - geometry.containerRight)).toBeLessThanOrEqual(1);
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("mobile drawers retain viewport gutters without horizontal clipping", async ({page}) => {
  test.skip((page.viewportSize()?.width || 0) > 1040);
  const assertDrawerFits = async drawer => {
    await expect(drawer).toHaveAttribute("open", "");
    const geometry = await drawer.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        left: bounds.left,
        right: bounds.right,
        scrollWidth: element.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(11);
    expect(geometry.viewportWidth - geometry.right).toBeGreaterThanOrEqual(11);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  };

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  await page.getByRole("button", {name: "Open navigation"}).click();
  await assertDrawerFits(page.locator("#mobile-nav"));

  if ((page.viewportSize()?.width || 0) <= 760) {
    await page.getByRole("button", {name: "Close navigation"}).click();
    await page.goto("/docs", {waitUntil: "domcontentloaded"});
    await settle(page);
    await page.getByRole("button", {name: "Browse docs"}).click();
    await assertDrawerFits(page.locator("#docs-menu"));
  }
});

test("a direct home fragment is fully styled without a layout shift", async ({page}) => {
  await page.addInitScript(() => {
    window.__dgcLayoutShifts = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__dgcLayoutShifts.push(entry.value);
      }
    }).observe({type: "layout-shift", buffered: true});
  });
  await page.goto("/#cli", {waitUntil: "load"});
  await expect(page.locator("html")).not.toHaveClass(/defer-styles/);
  await expect(page.locator("#cli")).toBeInViewport();
  await page.waitForTimeout(500);
  const cls = await page.evaluate(() => window.__dgcLayoutShifts.reduce((sum, value) => sum + value, 0));
  expect(cls).toBe(0);
});

test("a direct home fragment waits for a slow full stylesheet before alignment", async ({page}) => {
  await page.addInitScript(() => {
    window.__dgcLayoutShifts = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__dgcLayoutShifts.push(entry.value);
      }
    }).observe({type: "layout-shift", buffered: true});
  });
  await page.route("**/assets/site.css?*", async route => {
    await new Promise(resolve => setTimeout(resolve, 900));
    await route.continue();
  });

  await page.goto("/#cli", {waitUntil: "domcontentloaded"});
  await expect(page.locator("html")).not.toHaveClass(/defer-styles/, {timeout: 5_000});
  await expect(page.locator("#cli")).toBeInViewport();
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => ({
    cls: window.__dgcLayoutShifts.reduce((sum, value) => sum + value, 0),
    top: document.getElementById("cli")?.getBoundingClientRect().top,
  }));
  expect(result.cls).toBe(0);
  expect(Math.abs(result.top || 0)).toBeLessThan(1);
});

test("a stalled home fragment stylesheet fails open", async ({page}) => {
  await page.route("**/assets/site.css?*", () => new Promise(() => {}));
  await page.goto("/#cli", {waitUntil: "commit"});

  await expect(page.locator("html")).not.toHaveClass(/(?:defer-styles|fh)/, {timeout: 5_000});
  await expect(page.locator("body")).toHaveCSS("visibility", "visible");
  await expect(page.locator("h1")).toBeVisible();
});

test("a stalled home stylesheet fails open after first interaction", async ({page}) => {
  await page.route("**/assets/site.css?*", () => new Promise(() => {}));
  await page.goto("/", {waitUntil: "commit"});
  await page.keyboard.press("PageDown");

  await expect(page.locator("html")).not.toHaveClass(/(?:defer-styles|fh)/, {timeout: 5_000});
  await expect(page.locator("body")).toHaveCSS("visibility", "visible");
  await expect(page.locator("h1")).toBeVisible();
});

test("content-heavy routes do not reflow while a slow full stylesheet loads", async ({page}) => {
  await page.addInitScript(() => {
    window.__dgcLayoutShifts = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__dgcLayoutShifts.push(entry.value);
      }
    }).observe({type: "layout-shift", buffered: true});
  });
  await page.route("**/assets/site.css?*", async route => {
    await new Promise(resolve => setTimeout(resolve, 900));
    await route.continue();
  });

  for (const path of ["/changelog", "/docs", "/docs/getting-started"]) {
    await page.goto(path, {waitUntil: "load"});
    await expect(page.locator("html")).not.toHaveClass(/(?:defer-styles|fh)/);
    await expect(page.locator("body")).toHaveCSS("visibility", "visible");
    await page.waitForTimeout(500);
    const cls = await page.evaluate(() => window.__dgcLayoutShifts.reduce((sum, value) => sum + value, 0));
    expect(cls, path).toBe(0);
  }
});

test("direct fragments wait for full styles and align below the sticky header", async ({page}) => {
  await page.addInitScript(() => {
    window.__dgcLayoutShifts = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__dgcLayoutShifts.push(entry.value);
      }
    }).observe({type: "layout-shift", buffered: true});
  });
  await page.route("**/assets/site.css?*", async route => {
    await new Promise(resolve => setTimeout(resolve, 900));
    await route.continue();
  });

  for (const path of [
    "/about#work-on-this",
    "/security#permission-model",
    "/docs/getting-started#install",
  ]) {
    await page.goto(path, {waitUntil: "load"});
    await expect(page.locator("html")).not.toHaveClass(/(?:defer-styles|fh)/);
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      return {
        cls: window.__dgcLayoutShifts.reduce((sum, value) => sum + value, 0),
        top: target?.getBoundingClientRect().top,
        scrollMargin: target ? Number.parseFloat(getComputedStyle(target).scrollMarginTop) : null,
      };
    });
    expect(result.cls, path).toBe(0);
    expect(result.top, path).not.toBeNull();
    expect(Math.abs((result.top || 0) - (result.scrollMargin || 0)), path).toBeLessThan(1);
  }
});

test("late JavaScript cannot miss final fragment alignment after the CSS fail-open", async ({page}) => {
  const runtime = observeRuntime(page);
  await page.route("**/assets/site.js?*", async route => {
    await new Promise(resolve => setTimeout(resolve, 3200));
    await route.continue();
  });
  await page.route("**/assets/site.css?*", async route => {
    await new Promise(resolve => setTimeout(resolve, 3500));
    await route.continue();
  });

  await page.goto("/about#work-on-this", {waitUntil: "load"});
  await expect(page.locator("html")).toHaveAttribute("data-styles-ready", "true");
  const result = await page.locator("#work-on-this").evaluate(target => ({
    top: target.getBoundingClientRect().top,
    scrollMargin: Number.parseFloat(getComputedStyle(target).scrollMarginTop),
  }));
  expect(Math.abs(result.top - result.scrollMargin)).toBeLessThan(1);
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("the not-found page does not reflow while a slow full stylesheet loads", async ({page}) => {
  await page.addInitScript(() => {
    window.__dgcLayoutShifts = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__dgcLayoutShifts.push(entry.value);
      }
    }).observe({type: "layout-shift", buffered: true});
  });
  await page.route("**/assets/site.css?*", async route => {
    await new Promise(resolve => setTimeout(resolve, 900));
    await route.continue();
  });

  const response = await page.goto("/__definitely_missing__", {waitUntil: "load"});
  expect(response?.status()).toBe(404);
  await expect(page.locator("html")).not.toHaveClass(/(?:defer-styles|fh)/);
  await expect(page.locator("h1")).toBeVisible();
  await page.waitForTimeout(500);
  const cls = await page.evaluate(() => window.__dgcLayoutShifts.reduce((sum, value) => sum + value, 0));
  expect(cls).toBe(0);
});

test("a stalled docs stylesheet fails open", async ({page}) => {
  await page.route("**/assets/site.css?*", () => new Promise(() => {}));
  await page.goto("/docs", {waitUntil: "commit"});

  await expect(page.locator("html")).not.toHaveClass(/(?:defer-styles|fh)/, {timeout: 5_000});
  await expect(page.locator("body")).toHaveCSS("visibility", "visible");
  await expect(page.locator("h1")).toBeVisible();
});

test("a late docs stylesheet still applies and realigns after the fail-open deadline", async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  await page.route("**/assets/site.css?*", async route => {
    await new Promise(resolve => setTimeout(resolve, 3_500));
    await route.continue();
  });
  await page.goto("/docs/getting-started#install", {waitUntil: "load"});

  await expect(page.locator("#site-styles")).toHaveAttribute("media", "all");
  await expect(page.locator(".docs-article pre").first()).toHaveCSS("padding", "18px");
  await expect.poll(() => page.locator("#install").evaluate(target => Math.abs(
    target.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(target).scrollMarginTop),
  ))).toBeLessThan(1);
});

test("deferred enhancement does not rewind already-visible statistics", async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  await page.setViewportSize({width: 1440, height: 1200});
  await page.goto("/", {waitUntil: "load"});
  const stats = page.locator("[data-count]");
  const expected = await stats.evaluateAll(elements => elements.map(element => {
    const decimals = Number(element.dataset.decimals || 0);
    const value = Number(element.dataset.count).toFixed(decimals);
    return `${element.dataset.prefix || ""}${value}${element.dataset.suffix || ""}`;
  }));

  await page.waitForTimeout(6_250);
  await expect.poll(() => stats.allTextContents()).toEqual(expected);
  await expect.poll(() => stats.evaluateAll(elements => elements.map(element =>
    element.getAttribute("aria-label")))).toEqual(expected);
});

test("artifact views support complete keyboard tab navigation", async ({page}) => {
  const runtime = observeRuntime(page);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);

  const browser = page.locator("[data-artifact-tabs]");
  const tabs = browser.getByRole("tab");
  const address = browser.locator("[data-artifact-address]");
  await tabs.nth(0).focus();
  await tabs.nth(0).press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(browser.locator("#artifact-panel-files")).toBeVisible();
  await expect(address).toContainText("/files");

  await tabs.nth(1).press("End");
  await expect(tabs.nth(2)).toBeFocused();
  await expect(browser.locator("#artifact-panel-verify")).toBeVisible();
  await tabs.nth(2).press("ArrowRight");
  await expect(tabs.nth(0)).toBeFocused();
  await expect(browser.locator("#artifact-panel-plan")).toBeVisible();
  await tabs.nth(0).press("ArrowLeft");
  await expect(tabs.nth(2)).toBeFocused();
  await tabs.nth(2).press("Home");
  await expect(tabs.nth(0)).toBeFocused();

  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("editor capture autoplays in place and retains an explicit controls dialog", async ({page}) => {
  const runtime = observeRuntime(page);
  const mediaRequests = [];
  page.on("request", request => {
    if (/editor-capture\.(?:webm|mp4)$/.test(new URL(request.url()).pathname)) {
      mediaRequests.push(request.url());
    }
  });
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);

  const opener = page.locator('[data-open-capture="editor-capture"]');
  const preview = opener.locator("video[data-editor-preview]");
  const capture = page.locator("#editor-capture");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await expect(preview).not.toHaveAttribute("data-hydrated", "true");
  await expect(capture.locator("video")).not.toHaveAttribute("data-hydrated", "true");
  expect(mediaRequests).toEqual([]);

  await preview.scrollIntoViewIfNeeded();
  await expect(preview).toHaveAttribute("data-hydrated", "true");
  await expect.poll(() => preview.evaluate(video => !video.paused && Boolean(video.currentSrc)))
    .toBe(true);
  const previewState = await preview.evaluate(video => ({
    autoplay: video.autoplay,
    currentSrc: video.currentSrc ? new URL(video.currentSrc).pathname : "",
    loop: video.loop,
    muted: video.muted,
    paused: video.paused,
    playsInline: video.playsInline,
  }));
  expect(["/assets/editor-capture.mp4", "/assets/editor-capture.webm"])
    .toContain(previewState.currentSrc);
  expect({...previewState, currentSrc: "selected capture source"}).toEqual({
    autoplay: true,
    currentSrc: "selected capture source",
    loop: true,
    muted: true,
    paused: false,
    playsInline: true,
  });

  await opener.click();
  await expect(capture).toHaveAttribute("open", "");
  await expect(opener).toHaveAttribute("aria-expanded", "true");
  await expect(capture.locator("video")).toHaveAttribute("data-hydrated", "true");
  await expect(capture.locator("#editor-capture-note")).toContainText("not a live model session");
  await capture.locator("[data-close-capture]").click();
  await expect(capture).not.toHaveAttribute("open", "");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await expect(opener).toBeFocused();

  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});

test("editor capture preview selects the viewport-sized source", async ({page}) => {
  const posterRequests = [];
  page.on("request", request => {
    if (/editor-capture-poster(?:-720)?\.jpg$/.test(new URL(request.url()).pathname)) {
      posterRequests.push(request.url());
    }
  });
  await page.goto("/vscode", {waitUntil: "domcontentloaded"});
  const preview = page.locator('[data-open-capture="editor-capture"] video[data-editor-preview]');
  await expect(preview).toBeVisible();
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
  });
  await expect.poll(() => preview.evaluate(async video => {
    const first = video.getBoundingClientRect();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const second = video.getBoundingClientRect();
    const positive = first.width > 0 && first.height > 0
      && second.width > 0 && second.height > 0;
    const stable = Math.abs(first.top - second.top) <= 1
      && Math.abs(first.left - second.left) <= 1
      && Math.abs(first.width - second.width) <= 1
      && Math.abs(first.height - second.height) <= 1;
    return positive && stable;
  })).toBe(true);
  // Font settlement can move the tablet preview across the viewport boundary
  // for a frame. Treat that narrow prefetch zone as near-viewport; the strict
  // no-request assertion is meaningful only when the image starts well away.
  const startsNearViewport = await preview.evaluate(video => {
    const bounds = video.getBoundingClientRect();
    const margin = 64;
    return bounds.bottom >= -margin && bounds.top <= innerHeight + margin
      && bounds.right >= -margin && bounds.left <= innerWidth + margin;
  });
  if ((page.viewportSize()?.width || 0) <= 1040 && !startsNearViewport) {
    await page.waitForTimeout(250);
    expect(posterRequests).toEqual([]);
  }
  await preview.scrollIntoViewIfNeeded();
  const expected = (page.viewportSize()?.width || 0) <= 1040
    ? "/assets/editor-capture-poster-720.jpg"
    : "/assets/editor-capture-poster.jpg";
  await expect.poll(() => preview.evaluate(video => (
    video.poster ? new URL(video.poster).pathname : ""
  )))
    .toBe(expected);
});

test("benchmark score lines terminate at every plotted point", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  const panel = page.locator(".benchmark-panel");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toHaveClass(/\bin\b/);
  const readRows = () => panel.locator(".plot-row").evaluateAll(elements => elements.map(row => {
      const rowBox = row.getBoundingClientRect();
      const dotBox = row.querySelector(".plot-dot").getBoundingClientRect();
      const line = getComputedStyle(row, "::after");
      return {
        delta: Math.abs(Number.parseFloat(line.width) - (dotBox.left + dotBox.width / 2 - rowBox.left)),
        lineContent: line.content,
        transform: line.transform,
      };
    }));
  await expect.poll(async () => (await readRows()).every(row => (
    row.transform === "none" || row.transform === "matrix(1, 0, 0, 1, 0, 0)"
  )), {timeout: 5_000}).toBe(true);

  const rows = await readRows();
  expect(rows).toHaveLength(5);
  expect(rows.every(row => row.lineContent !== "none" && row.delta <= 1.5)).toBe(true);
  expect(rows.every(row => row.transform === "none" || row.transform === "matrix(1, 0, 0, 1, 0, 0)"))
    .toBe(true);
});

test("native pipeline animates in numbered order before its feedback retry", async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  const panel = page.locator("[data-pipeline]");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toHaveAttribute(
    "data-pipeline-sequence",
    "01,02,03,04,05,feedback,02,03,04,05,06",
  );
  const observed = await panel.evaluate(element => new Promise(resolve => {
    const seen = [];
    const record = () => {
      const step = element.dataset.activeStep;
      if (step && step !== "idle" && seen.at(-1) !== step) seen.push(step);
      if (seen.length >= 3) { observer.disconnect(); resolve(seen); }
    };
    const observer = new MutationObserver(record);
    observer.observe(element, {attributes: true, attributeFilter: ["data-active-step"]});
    record();
    setTimeout(() => { observer.disconnect(); resolve(seen); }, 3_200);
  }));
  expect(observed.slice(0, 3)).toEqual(["01", "02", "03"]);
});

test("power command demo types the complete command on focus", async ({page}) => {
  const runtime = observeRuntime(page);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);

  const card = page.locator("[data-command-demo]").first();
  const output = card.locator("[data-command-text]");
  const command = await output.getAttribute("data-command");
  await card.focus();
  await expect(card).toHaveClass(/command-complete/, {timeout: 3_000});
  await expect(output).toHaveText(command || "");
  await expect(output).toBeVisible();
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    commandOverflow: [...document.querySelectorAll(".power-command")]
      .some(element => element.scrollWidth > element.clientWidth + 1),
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.commandOverflow, "completed power commands must remain fully visible").toBe(false);
  expect(layout.scrollWidth, "typing a complete command must not create page overflow")
    .toBeLessThanOrEqual(layout.clientWidth + 1);

  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.httpErrors).toEqual([]);
});
