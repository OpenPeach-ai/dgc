---
name: browser-test
description: Exercise or add browser tests for a web application's user flows, responsive layouts and failure recovery using its existing browser automation setup.
---
Test the browser flow: $ARGUMENTS

Inspect the app's entry point, launch command, test configuration and supported browser. Use the
existing Playwright/browser harness or an available browser tool. This skill does not install a
browser or grant access by itself. If the tool is unavailable, prepare the check and report the exact
missing capability; source inspection is not a rendered-browser result.

Use a disposable profile and synthetic data. Start only the required local test services and retain
their handles for cleanup. Keep authentication storage, traces and screenshots containing private
state outside version control. Do not automate purchases, posts or other live writes beyond scope.

Drive the user-visible flow using roles, labels or stable test IDs. Await observable states rather
than fixed sleeps. Check the result after the action, including an appropriate rejection/cancel/retry
path. Isolate tests from each other's cookies and storage. Mock third-party dependencies where the
contract under test permits it, and label that boundary instead of claiming a live integration.

For layout changes, inspect a narrow and normal width, long content, keyboard operation and reduced
motion. Use actual screenshots when visual judgment is needed; inspect them before describing visual
results. Console/network errors may explain a failure, but successful network requests alone do not
prove the visible flow worked. Automated checks do not establish every accessibility property.

Fix confirmed issues when requested, rerun the affected flow, and stop your test processes. Report
browser/version, scenario, result and any mocked or untested boundary. Example: verify that a failed
save retains the form draft and a retry saves it exactly once, not merely that the Save button exists.

Reference for Playwright projects: [official testing guidance](https://playwright.dev/docs/best-practices).
