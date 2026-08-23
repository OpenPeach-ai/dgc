---
name: dgc-design
description: The DGC house style for any web UI or artifact — fonts, colors, spacing, and component recipes — so a frontend looks intentional and polished instead of default. Load before building one.
---
Build the frontend to DGC's house style: a calm, near-black canvas, one confident
purple accent, precise typography, and lots of breathing room. The goal is that
anything you ship *looks designed* — never a default Bootstrap/Tailwind starter.

Apply this to the thing named here (optional): $ARGUMENTS

## The feel
Dark, quiet, and precise — a developer tool that respects the eye. Restraint is
the whole aesthetic: one accent, generous negative space, hairline borders,
almost no shadows. If it looks busy or bright, you've gone wrong.

## Design tokens — paste these verbatim
Put this at the top of your CSS and build entirely from the variables. Do not
invent new colors; do not brighten the accent.

```css
:root{
  /* canvas */
  --bg:#0B0B0C; --surface:#141416; --surface-2:#1A1A1D; --code:#0E0E10; --term:#0A0A0B;
  /* lines */
  --border:#232326; --border-strong:#303034;
  /* text */
  --text:#F5F5F5; --text-strong:#FFFFFF; --muted:#9A9A9E; --faint:#6A6A6E;
  /* the one accent — purple */
  --accent:#7C5CFF; --accent-hover:#6A4BF0; --lav:#A78BFA; --accent-soft:rgba(124,92,255,.12);
  /* type */
  --ui:'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  --mono:'JetBrains Mono','SF Mono',ui-monospace,Menlo,Consolas,monospace;
  /* rhythm */
  --radius:12px; --radius-sm:8px; --gap:20px; --maxw:1120px;
}
*{box-sizing:border-box} html{-webkit-font-smoothing:antialiased}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--ui);
  font-size:16px;line-height:1.6;letter-spacing:-0.01em}
```

Fonts: prefer Google Fonts —
`<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">`.
Always keep the system fallbacks in the stacks above so it still looks right offline.

## Typography
- **Inter** for everything UI and prose; **JetBrains Mono** for code, data,
  numbers, keyboard keys, terminal output, and small technical labels.
- Tighten large text: headings use `letter-spacing:-0.02em` and `font-weight:700–800`.
- Scale, roughly: hero 44–60px / section title 28–32px / card title 18–20px /
  body 16px / caption 13px. Keep prose measure ≤ 68ch.
- Muted (`--muted`) for secondary text, `--faint` for the quietest labels. Never
  put long body text in pure white — reserve `--text-strong` for emphasis.

## Color use
- The purple accent is a **spotlight, not a coat of paint**: links, one primary
  button, a focus ring, a single key stat, an active state. Most of the page is
  greyscale on the dark canvas.
- Surfaces stack by elevation: `--bg` (page) → `--surface` (card) → `--surface-2`
  (nested/hover). Separate them with a 1px `--border`, not a shadow.
- `--accent-soft` is for gentle accent fills (a highlighted row, a badge bg).

## Layout & spacing
- Center content in a `max-width:var(--maxw)` column with `padding:0 24px`; go
  full-bleed only for backgrounds. On the home hero, feel free to run wider.
- Space generously — sections `padding:72px 0`, cards `padding:24–28px`,
  `gap:var(--gap)` in grids. Cramped spacing is the #1 tell of an undesigned page.
- Prefer CSS grid/flex with `gap` over margins. Round corners with `--radius`.

## Components (recipes)
- **Card:** `background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:24px`. On hover lift subtly:
  `border-color:var(--border-strong);transform:translateY(-1px)` with a
  `transition:.15s ease`.
- **Primary button:** `background:var(--accent);color:#fff;border:0;
  border-radius:var(--radius-sm);padding:11px 18px;font-weight:600`; hover
  `background:var(--accent-hover);transform:translateY(-1px)`.
- **Secondary button:** transparent bg, `1px solid var(--border-strong)`,
  `color:var(--text)`; hover raises the border to the accent.
- **Code / terminal block:** `background:var(--term);border:1px solid var(--border);
  border-radius:var(--radius);padding:16px;font-family:var(--mono);font-size:13.5px`.
  For a window chrome, add three 11px dots (`#2A2A2E`) as a title bar.
- **Focus ring (always visible):** `outline:2px solid var(--accent);outline-offset:2px`.

## The mark
DGC's logo is a monospace `///` — three forward slashes — in the accent, or with
the signature gradient for a hero:
`linear-gradient(112deg,#7C5CFF,#8B6FFF,#F3EEFF,#A78BFA,#6A4BF0)` clipped to text
(`background-clip:text;color:transparent`). Use it once, at the top. Don't repeat it.

## Motion
Subtle and fast only: 120–180ms ease on hover/focus, a gentle fade/translate on
first paint. No bounce, no parallax, no autoplaying motion. Respect
`@media (prefers-reduced-motion:reduce)` — drop transitions there.

## Rules
- **Self-contained:** inline all CSS and JS in the single HTML file (or a tiny
  local `styles.css`/`app.js` beside it). No build step, no framework CDN, no
  runtime npm. It must open straight from disk / the artifact URL.
- **Responsive:** it will be opened on phones AND laptops, so start the `<head>`
  with `<meta name="viewport" content="width=device-width, initial-scale=1">`.
  Use fluid widths and relative units (`%`, `rem`, `min()`, `clamp()`) — never a
  fixed pixel width wider than the screen; `max-width:100%` on img/svg/video, and
  wide content (tables, `pre`, charts) scrolls inside its OWN `overflow-x:auto`
  box, not the page. Stack to one column under ~720px with a media query. The
  page must NEVER scroll sideways — test at 375px wide.
- **Accessible:** real contrast (the tokens are tuned for it), semantic HTML,
  labelled controls, keyboard focus visible.
- **Ship light-on-dark by default.** Only build a light theme if asked; if you
  do, keep the same one-accent restraint.

Before you finish, look at it: is it quiet, aligned, and generously spaced, with
the accent used just once or twice? If yes, it's DGC-styled.
