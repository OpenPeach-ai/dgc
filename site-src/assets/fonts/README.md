# DGC wordmark font

`jetbrains-mono-extrabold-wordmark.woff2` contains the D, G, and C glyphs from
JetBrains Mono ExtraBold 2.304. This is the same family and version as the site's
existing Medium face, with its genuine weight 800 outlines. A dedicated CSS family
alias keeps this small subset scoped to the header/footer logo.

Source: https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/fonts/webfonts/JetBrainsMono-ExtraBold.woff2

Upstream SHA-256: `88097a36a292c145a14394f1fd5133f76b9a3d6fdb133834b2c94a3db61dd39a`

Subset SHA-256: `51f7a1777ed6df126a9a93d10432bdbbc1952e1a71137dc8264aedc7f9a38d99`

License: SIL Open Font License 1.1, retained in the public deployment at
[`site/assets/fonts/JetBrains-Mono-OFL.txt`](../../../site/assets/fonts/JetBrains-Mono-OFL.txt).
Copyright 2020 The JetBrains Mono Project Authors.

The 2,916-byte subset preserves the original names, glyph outlines, hinting, and
600-unit glyph advances at 1,000 units per em. It was produced with a temporary
FontTools 4.60.1 environment, not a project/runtime dependency:

```sh
pyftsubset JetBrainsMono-ExtraBold.woff2 --text=DGC --layout-features='' \
  --name-IDs='*' --name-legacy --name-languages='*' --flavor=woff2 \
  --output-file=jetbrains-mono-extrabold-wordmark.woff2
```

The site generator copies this source asset to the corresponding path in `site/`.
Do not replace it with a local system font or enable synthetic bold for `.brand`.
