import {expect, test} from "@playwright/test";

import {observeRuntime, settle} from "./support.mjs";

test("white hero uses the DGC logo without requesting background media", async ({page}) => {
  const runtime = observeRuntime(page);
  const backgroundRequests = [];
  page.on("request", request => {
    if (/\/(?:hero|sub|power)-(?:graded|mobile)/.test(new URL(request.url()).pathname)) backgroundRequests.push(request.url());
  });
  await page.goto("/", {waitUntil: "load"});
  await settle(page);
  await expect(page.locator(".hero-art .slash-cut")).toHaveCount(3);
  await expect(page.locator(".hero video, #subscription video, #power video")).toHaveCount(0);
  expect(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
  await page.locator("#power").scrollIntoViewIfNeeded();
  expect(backgroundRequests).toEqual([]);
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
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

test("the header and footer retain the animated DGC wordmark", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);

  const wordmarks = await page.locator(".site-header .brand,.site-footer .brand").evaluateAll(brands => (
    brands.map(brand => ({
      cursorAnimation: getComputedStyle(brand.querySelector(".brand-cursor")).animationName,
      cursorLabel: brand.textContent.trim(),
      slashAnimations: [...brand.querySelectorAll("svg path")]
        .map(path => getComputedStyle(path).animationName),
    }))
  ));

  expect(wordmarks).toHaveLength(2);
  expect(wordmarks.every(wordmark => wordmark.cursorLabel === "DGC")).toBe(true);
  expect(wordmarks.every(wordmark => wordmark.cursorAnimation === "brand-cursor-blink")).toBe(true);
  expect(wordmarks.every(wordmark => (
    wordmark.slashAnimations.length === 3
      && wordmark.slashAnimations.every(name => name === "brand-slash-pulse")
  ))).toBe(true);
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
        bottomLimit: target ? target.getBoundingClientRect().top + scrollY - Math.max(0, document.documentElement.scrollHeight - innerHeight) : null,
      };
    });
    expect(result.cls, path).toBe(0);
    expect(result.top, path).not.toBeNull();
    expect(Math.abs((result.top || 0) - Math.max(result.scrollMargin || 0, result.bottomLimit || 0)), path).toBeLessThan(1);
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
    bottomLimit: target.getBoundingClientRect().top + scrollY - Math.max(0, document.documentElement.scrollHeight - innerHeight),
  }));
  expect(Math.abs(result.top - Math.max(result.scrollMargin, result.bottomLimit))).toBeLessThan(1);
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

test("docs on-this-page highlights nothing at the top of a fresh load when the stylesheet is slow", async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  // Until the stylesheet lands the TOC and sidebar are hidden and every heading measures top 0, so a
  // scroll-spy that starts early marks the last heading ("Reference") active on an unscrolled page.
  await page.route("**/assets/site.css?*", async route => {
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto("/docs", {waitUntil: "domcontentloaded"});
  await settle(page);
  await expect(page.locator("html")).toHaveAttribute("data-styles-ready", "true");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(await page.locator(".docs-toc a.active").evaluateAll(links =>
    links.map(link => link.getAttribute("data-id")))).toEqual([]);
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
  expect(previewState.currentSrc).toBe("/assets/editor-capture.mp4");
  expect(mediaRequests.map(url => new URL(url).pathname))
    .toEqual(["/assets/editor-capture.mp4"]);
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

test("focus-pane scripted demo previews files without loading a recording", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  const runtime = observeRuntime(page);
  const media = [];
  page.on("request", request => {
    if (/files-replay\.json$|files-capture/.test(new URL(request.url()).pathname)) media.push(request.url());
  });
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  const demo = page.locator("[data-focus-demo]");
  await demo.scrollIntoViewIfNeeded();
  await demo.locator("[data-focus-replay]").click();
  await demo.locator("[data-focus-next]").click();
  await demo.locator("[data-focus-file=clamp]").click();
  await expect(demo.locator("[data-focus-preview]")).toContainText("return max(lower, min(upper, value))");
  await demo.locator("[data-focus-file=tests]").click();
  await expect(demo.locator("[data-focus-preview-title]")).toHaveText("test_clamp.py · preview");
  await demo.locator("[data-focus-next]").click();
  await expect(demo.locator("[data-focus-composer]")).toContainText("@clamp.py");
  await demo.locator("[data-focus-next]").click();
  await expect(demo.locator("[data-focus-state]")).toContainText("Agent finished");
  await expect(page.locator("#files-capture, [data-open-capture=files-capture]")).toHaveCount(0);
  expect(media).toEqual([]);
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
});

test("scripted tasks update the same checklist and retain completed items", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  const demo = page.locator("[data-scripted-demos]");
  await demo.scrollIntoViewIfNeeded();
  await demo.getByRole("tab", {name: "Track tasks"}).click();
  await demo.locator("[data-demo-replay]").click();
  const tasks = demo.locator("#demo-panel-tasks");
  await expect(tasks.locator("[data-demo-task]")).toHaveCount(3);
  await expect(tasks.locator("[data-task-count]")).toHaveText("0 of 3 complete");
  for (let i = 0; i < 6; i++) await demo.locator("[data-demo-next]").click();
  await expect(tasks.locator("[data-task-count]")).toHaveText("3 of 3 complete");
  await expect(tasks.locator('[data-demo-task][data-state="done"]')).toHaveCount(3);
  await demo.getByRole("tab", {name: "Track tasks"}).focus();
  await page.keyboard.press("ArrowRight");
  await expect(demo.getByRole("tab", {name: "Approve a plan"})).toBeFocused();
  await expect(demo.locator("#demo-panel-plan")).toBeVisible();
});

test("live-diff scripted demo attaches selected lines without loading a recording", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  const runtime = observeRuntime(page);
  const media = [];
  page.on("request", request => {
    if (/diff-replay\.json$|diff-capture/.test(new URL(request.url()).pathname)) media.push(request.url());
  });
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  const demo = page.locator("[data-diff-demo]");
  await demo.scrollIntoViewIfNeeded();
  await demo.locator("[data-diff-replay]").click();
  await expect(demo.locator("[data-diff-empty]")).toBeVisible();
  await expect(demo.locator("[data-diff-attach]")).toBeDisabled();
  await demo.locator("[data-diff-next]").click();
  await expect(demo.locator("[data-diff-code]")).toBeVisible();
  const added = demo.locator(".diff-added");
  await added.click();
  await expect(added).toHaveAttribute("aria-pressed", "true");
  await expect(demo.locator("[data-diff-selection]")).toContainText("1 line selected");
  await demo.locator("[data-diff-attach]").click();
  await expect(demo.locator("[data-diff-composer]")).toContainText("1 diff line attached");
  await expect(demo.locator("[data-diff-selection]")).toContainText("working tree stays unchanged");
  await demo.locator("[data-diff-replay]").click();
  for (let i = 0; i < 3; i++) await demo.locator("[data-diff-next]").click();
  await expect(demo.locator("[data-diff-composer]")).toContainText("2 diff lines attached");
  await expect(page.locator("#diff-capture, [data-open-capture=diff-capture]")).toHaveCount(0);
  expect(media).toEqual([]);
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

  const dgcLabel = panel.locator(".plot-row.dgc .plot-name");
  await expect(dgcLabel).toHaveText("DGC");
  const labelState = await dgcLabel.evaluate(label => {
    const bounds = label.getBoundingClientRect();
    const pointX = bounds.left + bounds.width / 2;
    const pointY = bounds.top + bounds.height / 2;
    return {
      painted: document.elementsFromPoint(pointX, pointY).includes(label),
      rowOverflowX: getComputedStyle(label.parentElement).overflowX,
    };
  });
  expect(labelState.rowOverflowX).toBe("visible");
  expect(labelState.painted).toBe(true);
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

// Hero stat band and hero mark. The full-page baselines cannot guard these: maxDiffPixelRatio 0.005
// over a tall capture tolerates tens of thousands of differing pixels, far more than an 18px text
// shift, a clipped focus ring or a mark bleeding off the edge. These tests measure geometry, and
// decode real pixels where geometry alone cannot fail.

const nextFrames = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function atWidth(page, width, height = 1000) {
  await page.setViewportSize({width, height});
  await nextFrames(page);
}

function readStatBand(grid) {
  const box = grid.getBoundingClientRect();
  const style = getComputedStyle(grid);
  const cells = [...grid.querySelectorAll(".stat")].map(cell => {
    const rect = cell.getBoundingClientRect();
    const cellStyle = getComputedStyle(cell);
    const label = cell.querySelector(".stat-label");
    const labelRange = document.createRange();
    labelRange.selectNodeContents(label);
    const labelStyle = getComputedStyle(label);
    return {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      contentLeft: rect.left + parseFloat(cellStyle.paddingLeft) + parseFloat(cellStyle.borderLeftWidth),
      contentRight: rect.right - parseFloat(cellStyle.paddingRight) - parseFloat(cellStyle.borderRightWidth),
      labelLines: label.getBoundingClientRect().height / parseFloat(labelStyle.lineHeight),
      labelTextRight: labelRange.getBoundingClientRect().right,
    };
  });
  return {
    left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width,
    contentLeft: box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth),
    contentRight: box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
    containerWidth: grid.closest(".container").getBoundingClientRect().width,
    tracks: style.gridTemplateColumns.split(" ").filter(Boolean),
    cells,
    docOverflow: document.documentElement.scrollWidth - innerWidth,
  };
}

function statRows(band) {
  const rows = new Map();
  for (const cell of band.cells) {
    const key = Math.round(cell.top);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(cell);
  }
  return [...rows.values()].map(row => row.sort((a, b) => a.left - b.left));
}

// Decode a PNG screenshot with the page's own image decoder and return its RGBA bytes. Screenshots
// use CSS pixels at deviceScaleFactor 1, so one image pixel is one CSS pixel.
async function decodePng(page, png) {
  const decoded = await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], {type: "image/png"}));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const {data} = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let binary = "";
    for (let at = 0; at < data.length; at += 0x8000) binary += String.fromCharCode(...data.subarray(at, at + 0x8000));
    return {width: bitmap.width, height: bitmap.height, b64: btoa(binary)};
  }, png.toString("base64"));
  return {width: decoded.width, height: decoded.height, data: Buffer.from(decoded.b64, "base64")};
}

const STAT_WIDTHS = [360, 390, 414, 640, 760, 761, 900, 1024, 1040, 1041, 1100, 1152, 1199, 1200, 1201, 1240, 1241, 1280, 1440, 1680];
// Two columns on phones, three up to 1200px, five from 1201px. The geometry and paint tests below
// assert this too: rows that are flush and correctly painted prove nothing if the media blocks were
// lost and the band shows five columns on a phone.
const statColumnsAt = width => (width <= 760 ? 2 : width <= 1200 ? 3 : 5);
// Five cells: 2 columns wrap to 3 rows (the last cell spans both), 3 columns to 2, 5 columns to 1.
const statRowsFor = columns => ({2: 3, 3: 2, 5: 1})[columns];

test("hero stat rows are flush with the grid at both ends, at every width", async ({page}, testInfo) => {
  // The band wraps to 3 and then 2 columns. With per-cell padding, rows after the first began 18px
  // right of the numbers above them, and rows ended 18px short of the grid on the right.
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  test.setTimeout(120_000);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  for (const width of STAT_WIDTHS) {
    await atWidth(page, width);
    const band = await page.locator(".stat-grid").evaluate(readStatBand);
    const rows = statRows(band);
    expect(band.tracks.length, `${width}px columns`).toBe(statColumnsAt(width));
    expect(rows.length, `${width}px rows`).toBe(statRowsFor(statColumnsAt(width)));
    for (const row of rows) {
      expect(Math.abs(row[0].contentLeft - band.contentLeft), `${width}px row start`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(band.contentRight - row.at(-1).contentRight), `${width}px row end`).toBeLessThanOrEqual(0.5);
    }
  }
});

test("hero stat labels never wrap while the band has five columns", async ({page}, testInfo) => {
  // At 11px the labels need a 1192px viewport to share one line, so the band is three columns up to
  // 1200px. A label that grows past its slack would wrap again in 5 columns; this sweep catches it.
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  test.setTimeout(120_000);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  const widths = [1192, 1200, 1201];
  for (let width = 1000; width <= 1400; width += 3) widths.push(width);
  let fiveColumnWidths = 0;
  for (const width of widths) {
    await atWidth(page, width);
    const band = await page.locator(".stat-grid").evaluate(readStatBand);
    expect(band.tracks.length, `${width}px columns`).toBe(statColumnsAt(width));
    if (band.tracks.length !== 5) continue;
    fiveColumnWidths += 1;
    const wrapped = band.cells.map((cell, index) => [index + 1, cell.labelLines]).filter(([, lines]) => lines > 1.5);
    expect(wrapped, `${width}px wrapped labels`).toEqual([]);
  }
  expect(fiveColumnWidths).toBeGreaterThan(50);
  for (const [width, columns] of [[1200, 3], [1201, 5], [1280, 5], [1440, 5], [1680, 5]]) {
    await atWidth(page, width);
    expect((await page.locator(".stat-grid").evaluate(readStatBand)).tracks.length, `${width}px`).toBe(columns);
  }
});

test("a long unbreakable stat label stays inside its cell and the container", async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  await page.locator(".stat-label").nth(3).evaluate(label => { label.textContent = `unbreakable-${"x".repeat(70)}`; });
  for (const width of [390, 900, 1440]) {
    await atWidth(page, width);
    const band = await page.locator(".stat-grid").evaluate(readStatBand);
    const cell = band.cells[3];
    expect(cell.labelTextRight, `${width}px text`).toBeLessThanOrEqual(cell.right + 0.5);
    expect(cell.right, `${width}px cell`).toBeLessThanOrEqual(band.right + 0.5);
    expect(Math.abs(band.width - band.containerWidth), `${width}px grid width`).toBeLessThanOrEqual(0.5);
    expect(band.docOverflow, `${width}px document overflow`).toBe(0);
  }
});

test("hero stat labels are at least 11px", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  const sizes = await page.locator(".stat-label").evaluateAll(labels =>
    labels.map(label => parseFloat(getComputedStyle(label).fontSize)));
  expect(sizes).toHaveLength(5);
  expect(sizes.every(size => size >= 11)).toBe(true);
});

test("no wrapped stat label line starts with a middle dot", async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  test.setTimeout(60_000);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  for (const width of [320, 360, 390, 414, 430, 462, 761, 1041]) {
    await atWidth(page, width);
    const starts = await page.locator(".stat-label").evaluateAll(labels => labels.flatMap((label, index) => {
      const left = label.getBoundingClientRect().left;
      const hits = [];
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let at = node.data.indexOf("·"); at >= 0; at = node.data.indexOf("·", at + 1)) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          if (Math.abs(range.getBoundingClientRect().left - left) < 1) hits.push(index + 1);
        }
      }
      return hits;
    }));
    expect(starts, `${width}px`).toEqual([]);
  }
});

test("stat band paints one rule per row, dividers in the gaps, nothing in the gutters", async ({page}, testInfo) => {
  // Dividers and row rules are pseudo-elements in the grid gaps, clipped horizontally by the grid.
  // Cell geometry is flush by construction, so only pixels show a rule at the wrong height, a
  // partial rule, a divider painted at a row start, or overhang leaking into the page gutter.
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  test.setTimeout(120_000);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  // Hide the mesh, the mark and the stat text (visibility keeps layout): subpixel text antialiasing
  // can land on the line colour, and only rule and divider paint is under test here.
  await page.addStyleTag({content: "html{scroll-behavior:auto!important}.hero-atmosphere,.hero-art,.stat-value,.stat-label{visibility:hidden!important}"});
  const margin = 16;
  for (const width of [320, 462, 463, 760, 761, 1191, 1192, 1200, 1201, 1240, 1700]) {
    await atWidth(page, width);
    await page.locator(".stat-grid").evaluate(grid => scrollTo(0, grid.getBoundingClientRect().top + scrollY - 160));
    await nextFrames(page);
    const band = await page.locator(".stat-grid").evaluate(readStatBand);
    expect(band.tracks.length, `${width}px columns`).toBe(statColumnsAt(width));
    expect(statRows(band).length, `${width}px rows`).toBe(statRowsFor(statColumnsAt(width)));
    const clip = {
      x: Math.floor(band.left) - margin,
      y: Math.floor(band.top) - margin,
      width: Math.ceil(band.right) - Math.floor(band.left) + margin * 2,
      height: Math.ceil(band.bottom) - Math.floor(band.top) + margin * 2,
    };
    const png = await page.screenshot({clip, animations: "disabled", caret: "hide", scale: "css"});
    const rows = statRows(band).map((cells, index) => ({
      top: Math.min(...cells.map(cell => cell.top)),
      bottom: Math.max(...cells.map(cell => cell.bottom)),
      ruleY: index === 0 ? band.top : Math.min(...cells.map(cell => cell.top)) - 11,
      dividers: cells.slice(1).map(cell => cell.left - 18),
    }));
    const {data, width: w, height: h} = await decodePng(page, png);
    // --line is #e3e3eb.
    const line = (x, y) => {
      const i = (y * w + x) * 4;
      return Math.abs(data[i] - 227) <= 2 && Math.abs(data[i + 1] - 227) <= 2 && Math.abs(data[i + 2] - 235) <= 2;
    };
    // Chromium snaps box edges to whole pixels, so the grid paints from round(left) to round(right).
    const left = Math.round(band.left) - clip.x;
    const right = Math.round(band.right) - clip.x - 1;
    let gutter = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) if ((x < left || x > right) && line(x, y)) gutter += 1;
    }
    const fullRules = [];
    for (let y = 0; y < h; y += 1) {
      let full = true;
      for (let x = left; x <= right && full; x += 1) full = line(x, y);
      if (full) fullRules.push(y + clip.y);
    }
    const rowReports = rows.map(row => {
      const y0 = Math.ceil(row.top - clip.y);
      const y1 = Math.floor(row.bottom - clip.y) - 1;
      const tall = [];
      for (let x = left; x <= right; x += 1) {
        let count = 0;
        for (let y = y0; y <= y1; y += 1) if (line(x, y)) count += 1;
        if (count >= (y1 - y0 + 1) * 0.9) tall.push(x);
      }
      const groups = tall.reduce((out, x) => {
        if (out.length && x - out.at(-1).at(-1) <= 1) out.at(-1).push(x); else out.push([x]);
        return out;
      }, []);
      let edge = 0;
      for (let y = y0; y <= y1; y += 1) {
        for (let x = left; x < left + 18; x += 1) if (line(x, y)) edge += 1;
        for (let x = right - 17; x <= right; x += 1) if (line(x, y)) edge += 1;
      }
      return {
        ruleY: row.ruleY,
        dividerGroups: groups.map(group => group[0] + clip.x),
        expectedDividers: row.dividers,
        edge,
      };
    });
    const result = {gutter, fullRules, rowReports};

    expect(result.gutter, `${width}px gutter pixels`).toBe(0);
    const ruleRuns = result.fullRules.reduce((out, y) => {
      if (out.length && y - out.at(-1).at(-1) <= 1) out.at(-1).push(y); else out.push([y]);
      return out;
    }, []);
    expect(ruleRuns.length, `${width}px rule rows ${JSON.stringify(ruleRuns)}`).toBe(rows.length);
    result.rowReports.forEach((report, index) => {
      const run = ruleRuns[index];
      expect(run.length, `${width}px row ${index + 1} rule thickness`).toBe(1);
      expect(Math.abs(run[0] - report.ruleY), `${width}px row ${index + 1} rule y`).toBeLessThanOrEqual(1);
      expect(report.dividerGroups.length, `${width}px row ${index + 1} dividers`).toBe(report.expectedDividers.length);
      report.expectedDividers.forEach((x, divider) => {
        expect(Math.abs(report.dividerGroups[divider] - x), `${width}px row ${index + 1} divider ${divider + 1}`)
          .toBeLessThanOrEqual(1);
      });
      expect(report.edge, `${width}px row ${index + 1} paint in the first/last 18px`).toBe(0);
    });
  }
});

test("the stat link's keyboard focus ring is not clipped by the band", async ({page}, testInfo) => {
  // The band clips horizontally. In two columns the SWE-bench link can end on the grid's right edge
  // (0.05px away at 463px), where an outside ring loses its right stroke.
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  test.setTimeout(60_000);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  await page.addStyleTag({content: "html{scroll-behavior:auto!important}.hero-atmosphere,.hero-art{visibility:hidden!important}"});
  const link = page.locator(".stat-label a");
  for (const width of [322, 463]) {
    await atWidth(page, width);
    await link.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect.poll(() => link.evaluate(element => element.matches(":focus-visible"))).toBe(true);
    await page.locator(".stat-grid").evaluate(grid => scrollTo(0, grid.getBoundingClientRect().top + scrollY - 160));
    await nextFrames(page);
    const geometry = await link.evaluate(element => {
      const grid = element.closest(".stat-grid").getBoundingClientRect();
      const style = getComputedStyle(element);
      const rects = [...element.getClientRects()];
      const rightmost = rects.reduce((a, b) => (b.right > a.right ? b : a));
      const ring = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
      return {
        gridLeft: grid.left, gridRight: grid.right,
        left: Math.min(...rects.map(r => r.left)) - ring, right: rightmost.right + ring,
        rect: {top: rightmost.top, bottom: rightmost.bottom, right: rightmost.right},
      };
    });
    expect(geometry.right, `${width}px ring right edge`).toBeLessThanOrEqual(geometry.gridRight + 0.5);
    expect(geometry.left, `${width}px ring left edge`).toBeGreaterThanOrEqual(geometry.gridLeft - 0.5);
    // The last 12px up to where the ring's right stroke ends, never past the grid's clipping edge.
    const clip = {
      x: Math.floor(Math.min(geometry.gridRight, geometry.right + 1)) - 12,
      y: Math.floor(geometry.rect.top) - 6,
      width: 12,
      height: Math.ceil(geometry.rect.bottom - geometry.rect.top) + 12,
    };
    const png = await page.screenshot({clip, animations: "disabled", caret: "hide", scale: "css"});
    const {data, width: w, height: h} = await decodePng(page, png);
    let tallest = 0; // longest lavender (#6441c7) column inside the grid's last 12px
    for (let x = 0; x < w; x += 1) {
      let count = 0;
      for (let y = 0; y < h; y += 1) {
        const i = (y * w + x) * 4;
        if (Math.abs(data[i] - 100) <= 30 && Math.abs(data[i + 1] - 65) <= 30 && Math.abs(data[i + 2] - 199) <= 30) count += 1;
      }
      tallest = Math.max(tallest, count);
    }
    // A full right stroke spans the fragment's height; allow the rounded corners.
    expect(tallest, `${width}px painted right stroke`).toBeGreaterThanOrEqual(Math.floor(geometry.rect.bottom - geometry.rect.top) - 6);
  }
});

test("critical and full stylesheets agree on the hero stat band and mark", async ({page}, testInfo) => {
  // The hero is styled twice: inline critical CSS first, then site.css. Any drift between the two
  // copies moves the band or the mark when the full stylesheet arrives.
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  test.setTimeout(60_000);
  const widths = [390, 761, 900, 1200, 1201, 1280, 1440];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/assets/site.css?*", async route => { await held; await route.continue(); });
  await page.goto("/", {waitUntil: "domcontentloaded"});
  const read = () => page.evaluate(() => {
    for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 0; }
    const grid = document.querySelector(".stat-grid");
    const rect = element => { const r = element.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(v => Math.round(v * 4) / 4); };
    return {
      tracks: getComputedStyle(grid).gridTemplateColumns,
      grid: rect(grid),
      cells: [...grid.querySelectorAll(".stat")].map(rect),
      mark: [...document.querySelectorAll(".hero-art .slash-cut")].map(rect),
      full: document.documentElement.dataset.stylesReady === "true",
    };
  });
  const critical = [];
  for (const width of widths) {
    await atWidth(page, width);
    critical.push(await read());
  }
  expect(critical.every(state => !state.full)).toBe(true);
  release();
  await page.evaluate(() => window.dispatchEvent(new Event("dgc:load-styles")));
  await expect(page.locator("html")).toHaveAttribute("data-styles-ready", "true", {timeout: 10_000});
  for (const [index, width] of widths.entries()) {
    await atWidth(page, width);
    const full = await read();
    expect({...full, full: false}, `${width}px`).toEqual(critical[index]);
  }
});

test("stacked table labels come from the markup and match their column headers", async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  await page.setViewportSize({width: 390, height: 844});
  const read = selector => page.locator(selector).evaluate(table => {
    const headers = [...table.querySelectorAll("thead th")].map(th => th.textContent.trim());
    return [...table.querySelectorAll("tbody tr")].flatMap(row => [...row.children].map((td, column) => ({
      column,
      header: headers[column],
      label: td.dataset.label ?? null,
      before: getComputedStyle(td, "::before").content,
    })));
  });

  await page.goto("/vscode", {waitUntil: "domcontentloaded"});
  await settle(page);
  await page.locator(".install-matrix").scrollIntoViewIfNeeded();
  const install = await read(".install-matrix");
  expect(install.length).toBe(12);
  for (const cell of install) {
    if (cell.column === 0) { expect(cell.label).toBeNull(); continue; }
    expect(cell.label, JSON.stringify(cell)).not.toBeNull();
    expect(cell.before).toBe(JSON.stringify(cell.label));
    expect(cell.label.toLowerCase()).toBe(cell.header.toLowerCase());
  }

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  await page.locator(".permission-table").scrollIntoViewIfNeeded();
  const permissions = await read(".permission-table");
  const gates = permissions.filter(cell => cell.column >= 1 && cell.column <= 3);
  expect(gates.length).toBe(12);
  for (const cell of gates) {
    expect(cell.label, JSON.stringify(cell)).not.toBeNull();
    expect(cell.before).toBe(JSON.stringify(cell.label));
    expect(cell.header.toLowerCase().startsWith(cell.label.toLowerCase()), JSON.stringify(cell)).toBe(true);
  }
});

function readHeroMark() {
  for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 0; }
  const art = document.querySelector(".hero-art");
  const hero = document.querySelector(".hero").getBoundingClientRect();
  let opacity = 1;
  for (let element = art; element; element = element.parentElement) opacity *= parseFloat(getComputedStyle(element).opacity);
  const slashes = [...art.querySelectorAll(".slash-cut")].map(path => path.getBoundingClientRect());
  const copy = [];
  const addText = (element, name) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    for (const rect of range.getClientRects()) copy.push([name, rect]);
  };
  const heroCopy = document.querySelector(".hero-copy");
  addText(heroCopy.querySelector(".eyebrow"), "eyebrow");
  addText(heroCopy.querySelector("h1"), "h1");
  addText(heroCopy.querySelector(".lede"), "lede");
  for (const element of document.querySelectorAll(".stat-value, .stat-label")) addText(element, "stat");
  for (const selector of [".hero-actions", ".install-panel"]) copy.push([selector, document.querySelector(selector).getBoundingClientRect()]);
  const overlaps = [];
  for (const slash of slashes) {
    for (const [name, rect] of copy) {
      const w = Math.min(slash.right, rect.right) - Math.max(slash.left, rect.left);
      const h = Math.min(slash.bottom, rect.bottom) - Math.max(slash.top, rect.top);
      if (w > 0 && h > 0 && w * h > 0.25) overlaps.push([name, Math.round(w * h)]);
    }
  }
  // Words per rendered line; \S+ also splits at a no-break space, so "you&nbsp;run" counts as two.
  const textLines = element => {
    const lines = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of node.data.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const top = Math.round(range.getBoundingClientRect().top);
        if (!lines.length || Math.abs(lines.at(-1).top - top) > 2) lines.push({top, words: []});
        lines.at(-1).words.push(match[0]);
      }
    }
    return lines.map(line => line.words);
  };
  const eyebrowLines = textLines(heroCopy.querySelector(".eyebrow"));
  return {
    opacity,
    fill: getComputedStyle(art.querySelector(".slash-cut")).fill,
    union: {
      left: Math.min(...slashes.map(r => r.left)), right: Math.max(...slashes.map(r => r.right)),
      top: Math.min(...slashes.map(r => r.top)), bottom: Math.max(...slashes.map(r => r.bottom)),
    },
    slashes: slashes.map(r => [r.left, r.top, r.right, r.bottom].map(v => Math.round(v * 2) / 2)),
    hero: {top: hero.top, bottom: hero.bottom},
    viewport: innerWidth,
    overlaps,
    eyebrowLastLineWords: eyebrowLines.at(-1).length,
    h1Lines: textLines(heroCopy.querySelector("h1")).map(words => words.join(" ")),
  };
}

function expectWholeMark(mark, label) {
  expect(mark.opacity, `${label} opacity`).toBe(1);
  expect(mark.fill, `${label} fill`).toBe("rgb(124, 92, 255)");
  expect(mark.union.left, `${label} left`).toBeGreaterThanOrEqual(0);
  expect(mark.union.right, `${label} right`).toBeLessThanOrEqual(mark.viewport);
  expect(mark.union.top, `${label} top`).toBeGreaterThanOrEqual(mark.hero.top);
  expect(mark.union.bottom, `${label} bottom`).toBeLessThanOrEqual(mark.hero.bottom);
  expect(mark.overlaps, `${label} overlaps`).toEqual([]);
  expect(mark.eyebrowLastLineWords, `${label} eyebrow last line`).toBeGreaterThan(1);
}

async function heroMarkIsWhole({page}) {
  // On phones the mark used to sit at 22% opacity with its right edge past the viewport, and the
  // tablet range bled 58px off the right. It must be whole, full strength, clear of the copy, and
  // placed identically by the critical CSS and by site.css.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/assets/site.css?*", async route => { await held; await route.continue(); });
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await page.evaluate(() => document.fonts.ready);
  const critical = await page.evaluate(readHeroMark);
  release();
  await settle(page);
  await expect(page.locator("html")).toHaveAttribute("data-styles-ready", "true", {timeout: 10_000});
  const full = await page.evaluate(readHeroMark);
  expectWholeMark(full, "full stylesheet");
  expect(full.slashes).toEqual(critical.slashes);
}

test("hero mark is whole, full strength and clear of the copy", heroMarkIsWhole);
test("hero mark is whole, full strength and clear of the copy with reduced motion @reduced", heroMarkIsWhole);

test("hero mark stays whole and clear of the copy from phone to wide desktop", async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  test.setTimeout(120_000);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  for (const width of [320, 360, 375, 390, 430, 463, 540, 600, 680, 760, 761, 800, 900, 1000, 1040, 1041, 1100, 1180, 1200, 1201, 1280, 1440, 1920]) {
    await atWidth(page, width);
    expectWholeMark(await page.evaluate(readHeroMark), `${width}px`);
  }
});

test("hero mark and headline stay clear without text-wrap balance (older Safari)", async ({page}, testInfo) => {
  // iOS Safari before 17.5 has no text-wrap:balance. A greedy line breaker used to set the headline
  // as "Own your coding / agent.", and at 364-500px "coding" ran under the full-strength phone mark;
  // the eyebrow also left "run" alone on its last line at 494-542px. The layout must not depend on it.
  test.skip(testInfo.project.name !== "chromium-desktop-1440");
  test.setTimeout(120_000);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  const widths = [320, 360, 364, 375, 390, 400, 414, 430, 440, 460, 480, 494, 500, 520, 540, 600, 700, 760, 761, 900, 1041, 1201, 1440];
  const balanced = {};
  for (const width of widths) {
    await atWidth(page, width);
    balanced[width] = await page.evaluate(readHeroMark);
  }
  await page.addStyleTag({content: "*{text-wrap:wrap!important}"});
  for (const width of widths) {
    await atWidth(page, width);
    const mark = await page.evaluate(readHeroMark);
    expectWholeMark(mark, `${width}px without balance`);
    expect(mark.h1Lines, `${width}px headline lines without balance`).toEqual(["Own your", "coding agent."]);
    expect(mark.h1Lines, `${width}px headline lines match the balanced layout`).toEqual(balanced[width].h1Lines);
  }
});

test("the hero stats band sits on the hero's own ground, not an opaque plate", async ({page}) => {
  // An opaque background ended in a hard vertical seam at each container edge, over the hero's
  // tinted atmosphere — the band read as a slice cut out of the page.
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await settle(page);
  const background = await page.locator(".stat-grid")
    .evaluate(el => getComputedStyle(el).backgroundColor);
  expect(background).toBe("rgba(0, 0, 0, 0)");
});
