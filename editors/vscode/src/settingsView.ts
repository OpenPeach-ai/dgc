/** A real editor tab. Assets are built into dist so installed and development hosts match. */
export function settingsDocument(scriptUri = "", styleUri = "", cspSource = ""): string {
  const attr = (value: string) => value.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};">
<link rel="stylesheet" href="${attr(styleUri)}"><title>DGC Settings</title></head>
<body><div class="shell"><aside class="sidebar"><div class="nav-head"><button class="icon-button" id="collapse-nav" title="Collapse navigation" aria-label="Collapse navigation" aria-expanded="true"></button><span>Settings</span></div><nav aria-label="Settings"></nav></aside><main id="main"><div class="page" id="page"><p role="status">Loading settings…</p></div></main></div><script src="${attr(scriptUri)}"></script></body></html>`;
}
