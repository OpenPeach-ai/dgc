# Website acceptance QA

These checks exercise the already-generated `site/` tree. They never build, deploy, publish, or
contact a production API.

## One-time setup

Use Node 22.19 or newer in the Node 22 line, then install the exact dependency graph and pinned
Chromium revision:

```bash
npm ci
npx playwright install chromium
```

Use `npx playwright install --with-deps chromium` on a fresh Ubuntu CI host.

## Gates

```bash
npm run qa:site
npm run qa:site:lighthouse
# both, in order
npm run qa:site:all
```

The browser matrix loads every route declared by `site/routes.json` at 390, 768, and 1440 CSS
pixels. It fails on console/page errors, local HTTP errors, horizontal overflow, missing page
landmarks, and same-origin Performance Resource Timing transfers over 600 KB on mobile or 900 KB
on desktop. The QA server disables caching and applies deterministic gzip to compressible text,
matching a conservative CDN transfer, so the measurement represents a cold local load. A
separate reduced-motion projects check every route at 390 and 1440 CSS pixels with the browser
preference enabled.

Six representative page families (`/`, `/benchmark`, `/vscode`, `/docs`, `/pricing`, `/changelog`)
have reviewed baselines at all three widths in `qa/site/baselines/<project>/<route>/`. They use the
reduced-motion final state so every section is visible and deterministic; the separate interaction
suite exercises the animated states.

Each page is compared section by section, not as one full-page image:

- **Bands.** The page is cut into contiguous full-width bands anchored on the DOM: the announcement,
  the header, each child of `main`, and the footer. Every pixel belongs to exactly one band, so a
  section whose height changes fails that band alone instead of shifting every capture below it.
  A band fails when more than **10 pixels** differ at a per-pixel threshold of 0.05. The budget is
  absolute: a 1px shift of one text box is over 100 differing pixels on any page, however tall.
  The announcement and footer are compared as pixels on the home page only.
- **Geometry.** `geometry.txt` records the document size, each band's box, and the box of every
  visible heading, paragraph, list item, table, figure, image, video, button, eyebrow, stat and card,
  relative to its band. It must match exactly, and its diff names the element that moved.
- **Orphans.** Band files are named after the section (`section-<id>`, or an ordinal when the
  section has no id). A renamed or removed section leaves a baseline that nothing produces; a normal
  run fails on it and `qa:site:update` deletes it. Give new sections an id so later insertions do not
  rename them.
- Visual tests never retry, and CI never writes a missing baseline.

Intentional visual changes must be inspected in the HTML report and updated explicitly:

```bash
npm run qa:site:update
git status --short -- qa/site/baselines
npm run qa:site
```

Never update baselines merely to clear CI. Review every changed PNG and geometry diff at all three
widths. A version bump changes the announcement, footer, docs version stub and changelog bands, so the
release refreshes them. Baselines are generated on Linux arm64 (Ubuntu 24.04), the same architecture
as the CI `site-acceptance` runner; regenerate them on that platform. Failure screenshots, traces,
and the HTML report stay under ignored `output/site-qa/`.

The browser matrix also checks `robots.txt` and every `sitemap.xml` URL through the QA server: each
listed URL must load, carry exactly that URL as its canonical, and not be noindex.

The fast pinned Lighthouse CI check audits the home, benchmark, and editor landing pages at the
same desktop (1440), tablet (768), and mobile (390) widths used by visual acceptance. Tablet and
mobile retain Lighthouse's stricter mobile scoring and throttling. The run stores HTML, JSON, and a
compact summary locally and requires performance
>= 95, accessibility >= 98, desktop LCP <= 1.0 s, tablet/mobile LCP <= 2.0 s, and CLS exactly 0. This
representative CI check is not the every-page release acceptance gate.

Before a release candidate is approved, run the explicit all-routes mode (30 routes x 3 profiles):

```bash
npm run qa:site:lighthouse:all
# complete browser + every-route Lighthouse acceptance
npm run qa:site:release
```

The same mode is available from the CI workflow's `workflow_dispatch` input. The local results are
useful acceptance evidence, but production CDN and field data remain the authority for real-user
performance.

If port 4173 belongs to another local app, run with `DGC_SITE_QA_PORT=45173` (or another free port). The browser runner still starts its own server and checks responses against that exact origin; it never reuses the other app.
