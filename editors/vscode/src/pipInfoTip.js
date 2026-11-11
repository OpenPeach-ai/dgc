// The small "i" beside a title on a Pip's settings: the sentence that explains a control is kept behind it, so the page
// shows a short title and the control. Pointing at the "i", or reaching it with the keyboard, shows the sentence; a click
// or a tap keeps it open until another click, Escape, or a click elsewhere. One is open at a time, and it is drawn inside
// the panel however narrow that is. The sentence itself stays in the page (hidden), so the control it explains names it
// with aria-describedby and a screen reader reads it with the control.

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true">'
  + '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v3.9"/><circle cx="8" cy="4.9" r=".5" fill="currentColor" stroke-width=".7"/></svg>';

/**
 * The "i" and its sentence. `id` names the sentence (the control it explains takes aria-describedby="<id>"); `about` is
 * the title it stands beside, for its spoken name; `html` is the sentence, already escaped. '' when there is none.
 */
export function infoTip(id, about, html) {
  if (!html) return '';
  const name = String(about).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  return `<span class="pip-tip"><button type="button" class="pip-tip-btn" data-pip-tip="${id}" aria-label="About ${name}" aria-expanded="false" aria-describedby="${id}">${ICON}</button>`
    + `<span class="pip-tip-text" id="${id}" role="tooltip" hidden>${html}</span></span>`;
}

/**
 * Makes every "i" under `root` work. `shell` is where the one floating sentence is drawn (the page's own box); `view`
 * the window. Returns a function that stops it.
 */
export function wireInfoTips({root, shell, view}) {
  const doc = shell.ownerDocument;
  let pop = null, open = '', pinned = false, pointed = '';
  const button = id => (id ? root.querySelector(`[data-pip-tip="${id}"]`) : null);
  const mark = () => { for (const b of root.querySelectorAll('[data-pip-tip]')) b.setAttribute('aria-expanded', String(b.dataset.pipTip === open)); };

  // Drawn inside the page's own box (the side bar's panel, or the editor tab), under its "i", or over it when there is
  // no room under. The box may be what a fixed thing is placed against (it is a container), so where "0, 0" lands is
  // measured, never assumed.
  function place() {
    const b = button(open);
    if (!pop || !b) return;
    const a = b.getBoundingClientRect(), box = shell.getBoundingClientRect(), edge = 8;
    const left0 = Math.max(0, box.left), right0 = Math.min(doc.documentElement.clientWidth, box.right);
    const top0 = Math.max(0, box.top), bottom0 = Math.min(doc.documentElement.clientHeight, box.bottom);
    pop.style.maxWidth = `${Math.max(120, Math.min(280, right0 - left0 - 2 * edge))}px`;
    pop.style.left = '0px'; pop.style.top = '0px';
    const zero = pop.getBoundingClientRect(), w = zero.width, h = zero.height;
    const left = Math.max(left0 + edge, Math.min(right0 - w - edge, a.left + a.width / 2 - 20));
    const below = a.bottom + 6, top = below + h <= bottom0 - edge || a.top - 6 - h < top0 + edge ? below : a.top - 6 - h;
    pop.style.left = `${Math.round(left - zero.left)}px`; pop.style.top = `${Math.round(top - zero.top)}px`;
  }
  function close() {
    if (!open) return;
    open = ''; pinned = false;
    pop?.remove(); pop = null;
    mark();
  }
  function show(id, pin) {
    const b = button(id), text = b && root.querySelector(`#${id}`);
    if (!b || !text) return;
    if (open !== id) {
      close();
      pop = doc.createElement('div');
      pop.className = 'pip-tip-pop dgc-popover'; pop.setAttribute('aria-hidden', 'true'); pop.dataset.pipTipFor = id;
      pop.innerHTML = text.innerHTML;
      shell.append(pop);
      open = id;
    }
    pinned = pinned || pin;
    mark(); place();
  }
  const tipOf = event => { const t = event.composedPath?.()[0] || event.target; return t?.closest?.('[data-pip-tip]') || null; };

  const over = event => { const b = tipOf(event); if (!b) return; pointed = b.dataset.pipTip; if (open !== pointed) show(pointed, false); };
  const out = event => { const b = tipOf(event); if (!b || b.contains(event.relatedTarget)) return; pointed = ''; if (open === b.dataset.pipTip && !pinned && root.activeElement !== b) close(); };
  const focusin = event => { const b = tipOf(event); if (b && open !== b.dataset.pipTip) show(b.dataset.pipTip, false); };
  const focusout = event => { const b = tipOf(event); if (b && open === b.dataset.pipTip && pointed !== open) close(); };
  const click = event => {
    const b = tipOf(event);
    if (!b) return;
    event.preventDefault(); event.stopPropagation();
    if (open === b.dataset.pipTip && pinned) close(); else show(b.dataset.pipTip, true);
  };
  const down = event => { if (open && !tipOf(event)) close(); };
  const key = event => { if (event.key !== 'Escape' || !open) return; event.preventDefault(); event.stopPropagation(); close(); };
  // A redraw replaces the page under an open sentence: it stays with its "i" while that is still there.
  const redrawn = () => { if (!open) return; if (button(open)) { mark(); place(); } else close(); };
  const watch = view.MutationObserver ? new view.MutationObserver(redrawn) : null;
  watch?.observe(root.querySelector('#app') || shell, {childList: true, subtree: true});
  const moved = () => { if (open) place(); };

  const on = [['mouseover', over], ['mouseout', out], ['focusin', focusin], ['focusout', focusout], ['click', click], ['pointerdown', down], ['keydown', key]];
  for (const [type, fn] of on) root.addEventListener(type, fn, true);
  view.addEventListener('resize', moved); root.addEventListener('scroll', moved, true);
  return () => {
    close(); watch?.disconnect();
    for (const [type, fn] of on) root.removeEventListener(type, fn, true);
    view.removeEventListener('resize', moved); root.removeEventListener('scroll', moved, true);
  };
}
