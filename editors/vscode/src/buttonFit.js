// DGC's button is one box whatever its words (media/shared/tokens.css, "The button"). Where a page's words vary (a
// provider's name, an account, a long action in Settings), this keeps it so: a button whose words do not fit the box
// takes the one wide size, and one whose words do not fit that either keeps the wide size, ends in an ellipsis and
// says them whole as its title. Called after a page draws; it reads and writes two things only: the class "wide"
// and the title.
export function fitButtons(root, selector) {
  for (const b of root.querySelectorAll(selector)) {
    if (!b.clientWidth) continue;                       // not laid out
    const said = (b.textContent || '').trim();
    if (b.dataset.fitFor === said) continue;            // measured for these words already
    b.dataset.fitFor = said;
    b.classList.remove('wide');
    if (b.scrollWidth > b.clientWidth + 1) b.classList.add('wide');
    if (b.scrollWidth > b.clientWidth + 1) { if (!b.title) { b.title = said; b.dataset.fitTitle = '1'; } }
    else if (b.dataset.fitTitle) { b.removeAttribute('title'); delete b.dataset.fitTitle; }
  }
}

/** Keeps every button under `root` matching `selector` fitted as the page redraws. Returns a function that stops it. */
export function watchButtons(root, selector, view = globalThis) {
  let queued = false;
  const again = () => { if (queued) return; queued = true; (view.requestAnimationFrame || view.setTimeout)(() => { queued = false; fitButtons(root, selector); }); };
  const seen = view.MutationObserver ? new view.MutationObserver(again) : null;
  seen?.observe(root, { childList: true, subtree: true, characterData: true });
  view.addEventListener?.('resize', again);
  again();
  return () => { seen?.disconnect(); view.removeEventListener?.('resize', again); };
}
