import {expect, test} from "@playwright/test";

import {observeRuntime, ROUTES, settle} from "./support.mjs";

for (const route of ROUTES) {
  test(`${route} respects reduced motion @reduced`, async ({page}) => {
    // Set it explicitly as well as at project level so this contract survives
    // future global-use refactors in the Playwright configuration.
    await page.emulateMedia({reducedMotion: "reduce"});
    const runtime = observeRuntime(page);
    await page.goto(route, {waitUntil: "domcontentloaded"});
    await settle(page);

    const motion = await page.evaluate(() => {
      const activeAnimations = document.getAnimations({subtree: true})
        .filter(animation => animation.playState === "running")
        .map(animation => {
          const target = animation.effect?.target;
          return target instanceof Element ? target.tagName.toLowerCase() : "unknown";
        });
      const hiddenReveals = [...document.querySelectorAll(".reveal")]
        .filter(element => {
          const style = getComputedStyle(element);
          return style.opacity !== "1" || style.transform !== "none";
        }).length;
      const playingVideos = [...document.querySelectorAll("video")]
        .filter(video => !video.paused).length;
      return {
        activeAnimations,
        hiddenReveals,
        matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
        playingVideos,
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      };
    });

    expect(motion.matches).toBe(true);
    expect(motion.scrollBehavior).toBe("auto");
    expect(motion.activeAnimations).toEqual([]);
    expect(motion.hiddenReveals).toBe(0);
    expect(motion.playingVideos).toBe(0);
    for (const output of await page.locator("[data-command-text]").all()) {
      await expect(output).toHaveText(await output.getAttribute("data-command") || "");
    }
    expect(runtime.consoleErrors).toEqual([]);
    expect(runtime.pageErrors).toEqual([]);
    expect(runtime.httpErrors).toEqual([]);
  });
}
