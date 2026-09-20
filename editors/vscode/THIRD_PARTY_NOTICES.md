# Third-party notices

## Visual Studio Code Codicons 0.0.46-24

`media/codicon.ttf` and the generated rules in `media/codicon.css` come from
[`@vscode/codicons` 0.0.46-24](https://www.npmjs.com/package/@vscode/codicons/v/0.0.46-24),
published by Microsoft Corporation from
<https://github.com/microsoft/vscode-codicons>.

- `codicon.ttf` SHA-256: `3819e4ae4b87350e7c37a5d8f24e71ada2f1f2ee58f7ce5ebc1f88e3c8c38c80`
- Upstream `codicon.css` SHA-256: `49a0152f315fb5e204daa54cc03eea8e79a830809cd501183ea3bbe33e959f1a`
- The only CSS change is correcting its license-file pointer to this extension's bundled notice.
- The Codicons artwork/font is licensed under Creative Commons Attribution 4.0;
  see `licenses/CODICONS-CC-BY-4.0.txt`.
- The accompanying generated code/styles are licensed under the MIT License;
  see `licenses/CODICONS-CODE-MIT.txt`.

Copyright © Microsoft Corporation.

## Lucide icons

The transcript's activity icons — the mark beside a tool step, a diff, a permission card or a
notice — are 37 [Lucide](https://lucide.dev) icons, from
[`lucide-react` 1.24.0](https://www.npmjs.com/package/lucide-react/v/1.24.0).

- Only the SVG path data is used, copied verbatim onto Lucide's 24x24 grid and embedded inline in
  `media/main.js`. No font, no icon file, and no runtime dependency on the package ships with this
  extension.
- The icons used are: `activity`, `app-window`, `blocks`, `book-open`, `bookmark`, `bot`, `braces`, `circle-alert`, `circle-check`, `circle-help`, `circle-slash`, `clipboard-list`, `code`, `external-link`, `file-diff`, `file-plus`, `file-text`, `folder-tree`, `globe`, `history`, `image`, `image-off`, `list-todo`, `notebook-pen`, `pencil`, `play`, `refresh-cw`, `search`, `shield`, `shield-plus`, `sparkle`, `square-pen`, `square-terminal`, `target`, `triangle-alert`, `unplug`, `wrench`.
- Lucide is licensed under the ISC License. Icons derived from Feather carry the MIT License.
  Both texts are reproduced in `licenses/LUCIDE-ISC.txt`, exactly as the package publishes them.

Copyright © Lucide Icons and Contributors; portions copyright © Cole Bemis (Feather).

## Markdown renderer

`dist/markdown.js` bundles [markdown-it](https://github.com/markdown-it/markdown-it)
15.0.1 and its browser dependencies: entities, linkify-it, mdurl, punycode.js, and uc.micro.
Exact dependency versions are locked in `package-lock.json`. Their copyright notices and licenses
are included in `licenses/MARKDOWN-LICENSES.txt`.

## Diagram renderer

`dist/mermaid.js` bundles [mermaid](https://github.com/mermaid-js/mermaid) 12.0.0 and the 62
browser packages it draws with — d3 and its modules, dagre-d3-es, cytoscape, elkjs, chevrotain,
katex, dompurify, roughjs and the rest. It is a separate file from `dist/extension.js` and is
fetched by the panel only when an answer actually contains a diagram. Exact dependency versions
are locked in `package-lock.json`. Every package's copyright notice and license is reproduced in
`licenses/MERMAID-LICENSES.txt`.
