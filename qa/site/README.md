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

Six representative page families have reviewed full-page baselines at all three widths in
`qa/site/baselines/`. They use the reduced-motion final state so every section is visible and
deterministic; the separate interaction suite exercises the animated states. More than 0.5% changed
pixels fails the run. Intentional visual changes must be inspected in the HTML report and updated
explicitly:

```bash
npm run qa:site:update
git diff --stat -- qa/site/baselines
npm run qa:site
```

Never update baselines merely to clear CI. Review each changed PNG at all three widths. Failure
screenshots, traces, and the HTML report stay under ignored `output/site-qa/`.

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
