# Pip characters

`plush.js` draws the eight Pips (Core, Scout, Lens, Patch, Rook, Pulse, Lock and Quill,
indices 0–7) from one transparent atlas, `plush-bodies.webp` (1660×948). Eyes are SVG
paths drawn over the atlas; Lens's eyes are clipped inside its glasses. There is no
WebGL, canvas, remote asset or per-character timer.

The renderer has no dependencies and does no DOM work on import. It registers
`globalThis.PipConcepts.plush` with:

- `styles`: one namespaced CSS string. Mount it once and pass `includeStyles: false` for lists.
- `markup({index, name}, state = 'idle', uid = 'plush', {includeStyles = true, paused = false})`:
  decorative markup for one character.
- `mount(root)`: pauses animation while the document is hidden; returns a cleanup function.

States are `idle`, `listening`, `thinking`, `working`, `waiting_approval`, `success`,
`failure` and `offline`. An unknown index or state throws rather than showing a different
Pip. Each instance needs a unique UID matching `[A-Za-z][A-Za-z0-9_-]{0,120}`; names are
escaped. Reduced motion stops all animation, as do `data-paused="true"`, an ancestor with
`data-pip-motion="paused"`, `.motion-paused` and `.motion-offscreen`.

A character never grants tools or permissions. The editor picks the identity from the
backend's catalog and the pose from the real run, runner or review state, and always writes
the status as text as well.

`wordmark.css` styles the Pips wordmark in the panel header.
