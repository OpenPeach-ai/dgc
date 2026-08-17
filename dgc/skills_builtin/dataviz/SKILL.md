---
name: dataviz
description: Build a clear, accessible chart or visualization — pick the chart type for the data relationship, use a colorblind-safe palette, label everything, support light/dark, and stay responsive.
---
Build a visualization for: $ARGUMENTS

Apply these defaults in whatever plotting library the project already uses (matplotlib, plotly, d3, Recharts, Vega, etc. — check the codebase first with grep before adding a new dependency).

Pick the chart type from the RELATIONSHIP in the data, not habit:
- Trend over time → line chart (area only when the magnitude/total matters).
- Comparison across categories → bar chart (horizontal when labels are long or numerous).
- Part-of-whole → stacked bar or a single bar; avoid pie charts beyond 2–3 slices.
- Distribution → histogram or box/violin.
- Correlation between two variables → scatter.
- Ranking → sorted bar (sort by value, not alphabetically).
Do not use a second Y-axis unless truly unavoidable — it invites misreading.

Color — make it colorblind-safe:
- Use a qualitative/categorical palette designed for accessibility (e.g. Okabe-Ito, ColorBrewer "Set2"/"Dark2", or Tableau 10). Avoid a red/green pairing as the only distinction.
- Encode ordered data with a single-hue SEQUENTIAL ramp; use a diverging ramp only when there's a meaningful midpoint (zero, a baseline).
- Keep to ~6–8 categorical colors; beyond that, group or use direct labels instead of more hues.
- Reinforce color with a second channel where you can (line style, markers, direct labels) so meaning survives in grayscale.

Labeling and clarity:
- Title says the takeaway. Label BOTH axes with units. Format numbers (thousands separators, %, currency) and dates humanly.
- Label series directly or give a clear legend; sort legend order to match the data.
- Start bar-chart Y-axes at zero. Never truncate a bar axis.

Chartjunk — remove it: no 3D, no heavy gridlines, no drop shadows, no background fills, no redundant decoration. Light gridlines only where they aid reading. Maximize data-ink.

Light/dark: drive colors from theme tokens/variables, not hardcoded hex where the framework offers a theme. Ensure text and marks meet contrast on BOTH backgrounds; don't rely on pure white or pure black.

Responsive: size from the container (width 100%, aspect ratio or viewBox), not fixed pixels. Let long axis labels rotate or wrap. Ensure it stays legible on a narrow screen.

Then render/build it and, where possible, verify it actually draws with sample data before declaring it done.
