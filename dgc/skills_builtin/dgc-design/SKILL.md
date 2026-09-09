---
name: dgc-design
description: Build a responsive, accessible frontend or HTML artifact using the project's design language. Use DGC's purple house style when requested or when creating an unbranded DGC artifact.
---
Design the requested interface: $ARGUMENTS

Inspect the existing components, theme tokens, layout, and requested references before changing
visuals. Preserve the user's brand, chosen light/dark theme, framework, and interaction requirements.
An existing product does not become DGC-branded merely because DGC builds it.

For DGC-branded surfaces or an unbranded standalone DGC artifact, start from the house palette:
near-black canvas #0B0B0C, surface #141416, text #F5F5F5, muted text #9A9A9E, and purple #7C5CFF.
Use purple for primary actions, selection and focus. Reuse existing tokens instead of introducing a
second theme. In an editor webview, inherit the host's theme, font size, contrast and reduced-motion
settings. These colors are starting points, not proof of accessible contrast in every combination.

Prefer the project's existing fonts and icons. For a new standalone artifact, use system sans-serif
and monospace stacks or existing local assets. Do not add remote font/CDN requests just for styling.
Keep standalone previews self-contained; product changes belong in the existing build system.

Build around the actual flow: hierarchy, readable line lengths, reachable primary actions, useful
empty/loading/error states and clear confirmation of completed work. Keep technical implementation
details out of product copy unless they help the user make a decision. Use spacing and alignment
before decorative cards, gradients or shadows. Do not invent a DGC logo for another product.

Use semantic controls, labels for icon buttons, visible keyboard focus and state cues beyond color.
Measure text and control contrast. Ensure menus and dialogs support keyboard dismissal and return
focus. Motion should be brief and purposeful; stop nonessential animation under reduced motion.

Check the narrowest supported layout and a normal desktop width. Keep the composer or primary action
reachable; long filenames, code and tables should scroll inside their own containers. Use a viewport
meta tag for standalone pages. Exercise long content and loading/error states in the real browser or
editor harness when available. Report source-only review honestly if it cannot be run.

Example: a customer asks for a light dashboard with green branding. Reuse that design and apply the
layout/accessibility guidance; do not replace it with DGC's dark purple theme.
