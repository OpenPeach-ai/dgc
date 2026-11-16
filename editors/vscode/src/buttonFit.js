// DGC's button is one box whatever its words (media/shared/tokens.css, "The button"). Where a page's words vary (a
// provider's name, an account, a long action in Settings), this keeps it so: a button whose words do not fit the box
// takes the one wide size, and one whose words do not fit that either keeps the wide size, ends in an ellipsis and
// says them whole as its title. Called after a page draws; it reads and writes two things only: the class "wide"
// and the title.
// Whether a button's words are wider than its room. scrollWidth is a whole number: words 0.1 px too wide ("Install ·
// 68 MB" in the 104 px box, 86.1 px of words in 86 px) end in an ellipsis and still measure as fitting (W21, user test
// 15 Nov). So the words themselves are measured, to the fraction, where the engine can.
function overflows(b) {
  if (b.scrollWidth > b.clientWidth + 1) return true;
  try {
    const view = b.ownerDocument.defaultView, range = b.ownerDocument.createRange();
    range.selectNodeContents(b);
    const words = range.getBoundingClientRect().width, style = view.getComputedStyle(b);
    const room = b.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    return words > 0 && room > 0 && words > room + 0.01;
  } catch { return false; }
}
export function fitButtons(root, selector) {
  for (const b of root.querySelectorAll(selector)) {
    if (!b.clientWidth) continue;                       // not laid out
    const said = (b.textContent || '').trim();
    if (b.dataset.fitFor === said) continue;            // measured for these words already
    b.dataset.fitFor = said;
    b.classList.remove('wide');
    if (overflows(b)) b.classList.add('wide');
    if (overflows(b)) { if (!b.title) { b.title = said; b.dataset.fitTitle = '1'; } }
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
