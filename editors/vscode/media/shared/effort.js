// The thinking slider (0.52, 15 Nov): one slider for Work's model menu and a Pip's (asked: "the thinking effort slider
// for Pips chat is not same looking as we have for work session, make it same, the only difference is, the white centre
// dot for slider gets replaced by that pip's face"). The track, its fill, the stops, the three words under it, the
// keyboard and what a screen reader hears are the same markup and the same rules (media/shared/effort.css); `thumb`
// puts a face where the dot is, the dot's own size, with the dot's focus ring. A classic script: Work's page loads it
// before its own script and the Pips bundle imports it, so both share DgcEffort.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcEffort) return;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const SEP = "|";
  const clean = (s) => String(s == null ? "" : s).split(SEP).join("/");

  /** The slider. `levels`: [{value, label}] from the least to the most; `at`: the chosen one's place; `ultra`: the track shimmers; `thumb`: a face's
   *  markup, drawn where the dot is; `byPointer`: it was last moved with the mouse, so it draws no focus ring. */
  function html({ levels, at = 0, id = "", label = "Thinking effort", title = "", disabled = false, ultra = false, thumb = "", byPointer = false }) {
    const most = Math.max(1, levels.length - 1), index = Math.max(0, Math.min(most, Number(at) || 0)), now = levels[index] || levels[0];
    return `<div class="effort-control${thumb ? " has-face" : ""}${ultra ? " is-ultra" : ""}" style="--effort:${index / most * 100}%;--effort-t:${index / most}">`
      + `<input${id ? ` id="${esc(id)}"` : ""} class="effort-slider${byPointer ? " by-pointer" : ""}" type="range" min="0" max="${most}" step="1" value="${index}"`
      + ` data-profiles="${esc(levels.map((l) => clean(l.value)).join(","))}" data-words="${esc(levels.map((l) => clean(l.label)).join(SEP))}"`
      + ` aria-label="${esc(label)}" aria-valuetext="${esc(now.label)}"${title ? ` title="${esc(title)}"` : ""}${disabled ? " disabled" : ""}/>`
      + (thumb ? `<span class="effort-face" aria-hidden="true">${thumb}</span>` : "")
      + `<div class="effort-labels" data-at="${index === 0 ? "start" : index === most ? "end" : ""}"><span>${esc(levels[0].label)}</span><output>${esc(now.label)}</output><span>${esc(levels[most].label)}</span></div></div>`;
  }
  /** The stop a slider is at: {index, value, label, most}. */
  function read(slider) {
    const values = String(slider.dataset.profiles || "").split(","), words = String(slider.dataset.words || "").split(SEP);
    const most = Math.max(1, values.length - 1);
    const index = Math.max(0, Math.min(most, Number(slider.value) || 0));
    return { index, most, value: values[index], label: words[index] || "" };
  }
  /** The slider follows the hand: its fill, its word, what a screen reader hears, and a small bump at the new stop.
   *  Nothing is saved here; the page saves on `change`. */
  function follow(slider) {
    const control = slider.closest ? slider.closest(".effort-control") : slider.parentElement;
    if (!control) return null;
    const now = read(slider);
    control.style.setProperty("--effort", `${now.index / now.most * 100}%`);
    control.style.setProperty("--effort-t", String(now.index / now.most));
    slider.setAttribute("aria-valuetext", now.label);
    const out = control.querySelector("output"); if (out) out.textContent = now.label;
    // (At either end the end's own word says it: the middle word is not said twice, "Off … Off … Ultra".)
    const labels = control.querySelector(".effort-labels"); if (labels) labels.dataset.at = now.index === 0 ? "start" : now.index === now.most ? "end" : "";
    // Acknowledge the step. Restarting the class is what replays the keyframe.
    control.classList.remove("bumped");
    void control.offsetWidth;
    control.classList.add("bumped");
    return now;
  }
  root.DgcEffort = { html, read, follow };
})();
