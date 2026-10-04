# Plush renderer

The extension uses `plush.js` and the packaged `plush-bodies.png`, with SVG eye
expressions and CSS body movement. The eight character IDs and state IDs stay
unchanged. No WebGL, remote asset host, new dependency or per-character timer.
A shared visibility listener pauses CSS animation when the document is hidden;
existing viewport observers and user motion preferences also pause it.

The PNG is an alpha-prepared derivative of the founder-approved soft-tone,
accessorized atlas. It was produced with the image-editing tool on 2026-10-04,
removing the white background and floor shadows. It is not byte-identical to the
approved white-backed source. Both originals and the approved snapshot remain
unchanged in the isolated design workspace. The derivative needs the founder's
final visual check before release; it is used only in this local build.

The atlas has genuine RGBA transparency, 1660×948, 1,278,695 bytes. ViewBox crops
preserve the accessories; the Lens eye overlays are clipped inside its glasses.
Source PNG: `~/.codex/generated_images/01a0bdb9-e8c7-7c23-aa30-55a6886a2e54/exec-cbd5cb1c-05bf-4acd-9d49-d9838c9b9ebb.png`.

The earlier orb renderer and its attribution files remain for design history.
The shared Pip chat, setup-review rows, and run rows use the plush renderer.
Status is always also written as text; appearance never authorizes work.
