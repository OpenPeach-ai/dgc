# DGC Pip characters

`orb.js` is the selected character renderer from the isolated lab's `characters/orb-study/`, with the subsequent user-approved eye-only expressions, light color families, mesh body and edge glow. It preserves eight identities and distinct silhouettes. The earlier `paper.js` stays here as archived artwork; it is no longer imported by the Pips client.

The renderer has no dependencies or DOM work during import. It registers `globalThis.PipConcepts.orb` with:

- `styles`: one shared, namespaced CSS string.
- `markup({index, name}, state='idle', uid='orb', {includeStyles=true, paused=false})`: decorative markup. Mount `styles` once and use `includeStyles:false` for lists.

Indices 0–7 are Core, Scout, Lens, Patch, Rook, Pulse, Lock and Quill. States are idle, listening, thinking, working, waiting_approval, success, failure and offline. Invalid indices/states throw instead of displaying a different Pip. Each instance requires a unique UID matching `[A-Za-z][A-Za-z0-9_-]{0,120}`. Names are escaped. All SVG definitions use that instance prefix; eye gradients use user-space coordinates so vertical strokes stay visible.

The root `.dgc-orb` fills its wrapper's width with a 1:1 aspect ratio. Every internal selector and keyframe is namespaced. Reduced motion disables loops. Pause is supported through root `data-paused="true"`, ancestor `data-pip-motion="paused"`, `.motion-paused`, or `.motion-offscreen`. The editor supplies an IntersectionObserver and shared visibility state. CSS drives body, blink and gaze motion; `mount(root)` drives the WebGL mesh and returns a cleanup function. The mesh uses a shared rendering loop, stops while hidden/paused, and has a CSS fallback. State changes replace face markup; this dependency-free adapter does not import the study's React/Motion path-morph runtime.

Remote uses a byte-for-byte copy of this canonical file and extracts `styles` to one static stylesheet. Resync copies after changing the renderer; do not maintain separate geometry or palette definitions in each product surface.

`test/pips-editor.test.mjs` verifies the selected asset hash, all 64 identity/state combinations, escaped names, unique SVG IDs, zero-width-safe eye gradients, scoped CSS, and the main Pips UI's truthful state/motion behavior. The archived Paper pals hash remains covered separately.

The base gradient component was supplied by the user; its upstream license has not been independently verified. Eye path construction is adapted from AIMO's MIT-licensed source; retain `AIMO-LICENSE`. The mesh shader is adapted from Paper Shaders under Apache-2.0; retain `PAPER-SHADERS-LICENSE`. This does not grant rights to AIMO commercial assets. Further provenance is in `characters/orb-study/NOTES.md` in the isolated lab.

A character never grants tools or permissions. The editor selects identity from the trusted backend catalog and derives pose from actual run/runner/review state; text remains authoritative without motion.
