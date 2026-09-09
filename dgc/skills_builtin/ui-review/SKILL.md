---
name: ui-review
description: Review an interface against a supplied design or reference application using actual interaction, responsive layouts, accessibility checks, and concrete findings. Use when explicitly asked to review UI behavior or visual fidelity.
---
Review the interface: $ARGUMENTS

1. Identify the requested reference, exact version if given, and the flows under review. Inspect the
   existing components, theme tokens, state transitions, and test tools before proposing changes.
2. Exercise the real interface with the project's browser or editor test harness. Use a disposable
   workspace and synthetic content. Check empty, loading, streaming, success, error, cancellation,
   and restored-session states; do not infer these states from a screenshot alone.
3. Compare wide and narrow layouts. Verify that scrolling stays in the intended region, controls
   remain reachable, menus stay inside the viewport, and streamed content does not steal the user's
   scroll position. Respect the host theme and reduced-motion preference.
4. Use the keyboard: Tab and Shift+Tab, Enter, Escape, arrow keys, and text composition. Check names
   for icon buttons, visible focus, dialog focus boundaries, and errors that are understandable
   without relying on color alone.
5. For generated content, verify real Markdown, exact code copying, safe file/source links, tool
   call/result correlation, and truthful final/error states. Test long content and late responses.
6. Report reproducible findings with severity, trigger, expected behavior, observed behavior, and
   the relevant file. If implementation is requested, fix the confirmed problems and rerun the
   affected flows. Keep private reference captures, account data, and recordings out of commits.

Do not copy proprietary source or assets from a reference application. Use observations to build
the requested behavior with the project's own components and visual identity. Do not claim visual
verification when the interface could not be run.
