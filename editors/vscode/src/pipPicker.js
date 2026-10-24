// A big face with a dropdown beside it (the founder, 24 Oct): how New Pip picks a Project Pip's job or a Personal Pip's
// character, and how a Personal Pip's page picks its face. The face shows what is chosen and changes with the choice.
// A native <select> can't show the small faces, so the dropdown is the WAI-ARIA collapsible listbox: a button with
// aria-haspopup="listbox" and aria-expanded opens a role="listbox" popup of role="option" rows, aria-selected on the
// chosen one. The open list has the focus and aria-activedescendant names the row the keys are on. Arrows, Home and End
// move, typing a row's first letters goes to it, Enter or Space picks, Esc closes it and gives the focus back to the
// button, Tab closes it and moves on, and a click outside it closes it. A choice that can't be made stays in the list,
// greyed, with its reason. The list drops down inside the box it sits in (the dialog scrolls) or flips up, and it
// never sticks out of the page.

const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chevron = '<svg class="pip-picker-chevron" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';

/**
 * The face and the dropdown. `options` are {value, label, aside?, face?, disabled?, reason?}: `label` is what the row
 * and the button say, `aside` is said beside it in the row (a Project Pip's character name), `face` is the row's small
 * face (an avatar's markup) and `reason` says why a disabled row can't be picked. `face` is the big face's markup.
 */
export function pickerMarkup({ id, label, value, options, face, placeholder = 'Choose…', disabled = false, size = '' }) {
  const chosen = options.find((o) => o.value === value && !o.disabled);
  const row = (o) => {
    const said = [o.label, o.aside].filter(Boolean).join(', ') + (o.disabled && o.reason ? `. ${o.reason}` : '');
    return `<div role="option" id="${escape(`${id}-${o.value}`)}" class="pip-picker-option" data-pick="${escape(o.value)}" aria-selected="${!!chosen && o.value === chosen.value}"`
      + `${o.disabled ? ` aria-disabled="true" title="${escape(o.reason || 'Not available yet')}"` : ''}${o.aside || (o.disabled && o.reason) ? ` aria-label="${escape(said)}"` : ''}>`
      + `${o.face || ''}<span class="pip-picker-words"><span class="pip-picker-main">${escape(o.label)}</span>${o.disabled && o.reason ? `<small class="pip-picker-reason">${escape(o.reason)}</small>` : ''}</span>`
      + `${o.aside ? `<span class="pip-picker-aside">${escape(o.aside)}</span>` : ''}</div>`;
  };
  return `<div class="pip-picker${size ? ` ${escape(size)}` : ''}" data-picker="${escape(id)}"><div class="pip-picker-face">${face || ''}</div>`
    + `<div class="pip-picker-field"><span class="pip-picker-label" id="${escape(id)}-label">${escape(label)}</span><div class="pip-picker-anchor">`
    + `<button type="button" id="${escape(id)}" class="pip-picker-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="${escape(id)}-list" aria-labelledby="${escape(id)}-label ${escape(id)}-value"${disabled ? ' disabled' : ''}>`
    + `<span class="pip-picker-value${chosen ? '' : ' placeholder'}" id="${escape(id)}-value">${escape(chosen ? chosen.label : placeholder)}</span>${chevron}</button>`
    + `<div class="pip-picker-list" id="${escape(id)}-list" role="listbox" tabindex="-1" aria-labelledby="${escape(id)}-label" hidden>${options.map(row).join('')}</div>`
    + '</div></div></div>';
}

/**
 * What the dropdowns do, for a page that redraws: one per mounted view, given the root it looks in (a document or a
 * shadow root) and what to do with a pick. Whether a list is open lives here, so a redraw while one is open opens it
 * again (`restore`). The view sends it its clicks, keys and focus changes; each returns true when it was the picker's.
 */
export function createPicker({ root, onPick, now = () => Date.now() }) {
  let openId = '', activeValue = '', typed = { text: '', at: 0 }, grown = null;
  const byId = (id) => (root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`));
  const parts = (id) => { const button = id && byId(id), list = id && byId(`${id}-list`); return button && list ? { button, list, anchor: button.closest('.pip-picker-anchor') || button.parentElement } : null; };
  const rows = (list) => [...list.querySelectorAll('[role=option]')];
  const usable = (list) => rows(list).filter((o) => o.getAttribute('aria-disabled') !== 'true');
  const activeOf = (list) => { const at = list.getAttribute('aria-activedescendant'); return at ? rows(list).find((o) => o.id === at) || null : null; };

  function keepInView(list, option) {
    if (!option || !list.clientHeight) return;
    const top = option.offsetTop, bottom = top + option.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = Math.max(0, top - 4);
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
  }
  function setActive(list, option, scroll = true) {
    for (const o of rows(list)) o.classList.toggle('active', o === option);
    if (option) { list.setAttribute('aria-activedescendant', option.id); activeValue = option.dataset.pick; if (scroll) keepInView(list, option); }
    else list.removeAttribute('aria-activedescendant');
  }
  // Drop down if it fits below the button, inside every box that clips it and the page; else flip up if there is more
  // room above; else drop down and scroll inside. A dialog shorter than it may be first grows down to hold the list, its
  // top (and the button) staying where they are; a box with more to show below scrolls the button up when neither way
  // has room.
  function place(list, button) {
    list.classList.remove('up'); list.style.maxHeight = '';
    const win = list.ownerDocument?.defaultView;
    if (!win || !button.getBoundingClientRect().height) return;   // nothing is laid out (a test's DOM)
    const gap = 6, natural = list.offsetHeight;
    list.style.maxHeight = '0px';   // while measuring, the list itself gives the box nothing more to scroll
    const bounds = () => {
      let top = 0, bottom = win.innerHeight, scroller = null;
      for (let a = list.parentElement; a; a = a.parentElement) {
        const s = win.getComputedStyle(a);
        if (s.overflowY === 'visible') continue;
        const r = a.getBoundingClientRect(), inner = r.top + a.clientTop;
        top = Math.max(top, inner); bottom = Math.min(bottom, inner + a.clientHeight);
        if (!scroller && ['auto', 'scroll'].includes(s.overflowY)) scroller = a;
      }
      const b = button.getBoundingClientRect();
      return { below: bottom - b.bottom - 2 * gap, above: b.top - top - 2 * gap, top, b, scroller };
    };
    let room = bounds();
    const fits = (space) => natural <= space + 0.5;
    const dialog = list.closest('.dialog'), holder = dialog?.parentElement;
    if (dialog && holder && !fits(room.below)) {
      const r = dialog.getBoundingClientRect(), most = parseFloat(win.getComputedStyle(dialog).maxHeight), pad = parseFloat(win.getComputedStyle(holder).paddingTop) || 0;
      const grow = Math.min(Math.ceil(natural - room.below), Math.floor(Math.min((Number.isFinite(most) ? most : Infinity) - r.height, (holder.clientHeight - 2 * pad - r.height) / 2)));
      if (grow > 0) { grown = dialog; dialog.style.minHeight = `${r.height + grow}px`; dialog.style.marginTop = `${grow}px`; room = bounds(); }
    }
    const enough = Math.min(natural, 170), more = room.scroller ? room.scroller.scrollHeight - room.scroller.clientHeight - room.scroller.scrollTop : 0;
    if (room.below < enough && room.above < enough && more > 0) { room.scroller.scrollTop += Math.min(more, room.b.top - room.top - gap); room = bounds(); }
    const up = !fits(room.below) && room.above > room.below, space = up ? room.above : room.below;
    list.classList.toggle('up', up);
    list.style.maxHeight = fits(space) ? '' : `${Math.max(60, Math.floor(space))}px`;
  }
  // Opens on the row given, else the chosen one, else the first (or the last, from the Up arrow).
  function open(id, { value = '', last = false } = {}) {
    const p = parts(id);
    if (!p || p.button.disabled) return false;
    if (openId && openId !== id) close(false);
    openId = id; typed = { text: '', at: 0 };
    p.list.hidden = false; p.button.setAttribute('aria-expanded', 'true');
    place(p.list, p.button);
    const items = usable(p.list), chosen = items.find((o) => o.getAttribute('aria-selected') === 'true');
    setActive(p.list, (value && items.find((o) => o.dataset.pick === value)) || chosen || (last ? items[items.length - 1] : items[0]) || null);
    p.list.focus({ preventScroll: true });
    return true;
  }
  function close(focus = true) {
    const p = parts(openId);
    openId = '';
    if (grown) { grown.style.minHeight = ''; grown.style.marginTop = ''; grown = null; }
    if (!p) return;
    p.list.hidden = true; p.button.setAttribute('aria-expanded', 'false'); setActive(p.list, null);
    p.list.classList.remove('up'); p.list.style.maxHeight = '';
    if (focus) p.button.focus({ preventScroll: true });
  }
  function pick(id, option) {
    if (!option || option.getAttribute('aria-disabled') === 'true') return;
    const value = option.dataset.pick;
    close(true);
    onPick(id, value);
  }
  // Typing goes to the next row whose words (or the name beside them) start with what was typed in the last moment;
  // one letter typed again goes on to the next row with that letter.
  function typeAhead(list, key) {
    const t = now();
    typed = { text: t - typed.at > 800 ? key.toLowerCase() : typed.text + key.toLowerCase(), at: t };
    const items = usable(list), at = items.indexOf(activeOf(list)), text = typed.text;
    const words = (o) => [...o.querySelectorAll('.pip-picker-main, .pip-picker-aside')].map((e) => e.textContent.trim().toLowerCase());
    const find = (q, from) => { for (let k = 0; k < items.length; k++) { const o = items[(from + k + items.length) % items.length]; if (words(o).some((w) => w.startsWith(q))) return o; } return null; };
    const hit = find(text, text.length === 1 ? at + 1 : Math.max(at, 0)) || ([...text].every((c) => c === text[0]) ? find(text[0], at + 1) : null);
    if (hit) setActive(list, hit);
  }
  function keydown(event) {
    const target = event.target;
    if (!openId) {
      if (target?.classList?.contains('pip-picker-button') && !target.disabled && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault(); open(target.id, { last: event.key === 'ArrowUp' });
        return true;
      }
      return false;
    }
    const p = parts(openId);
    if (!p) { openId = ''; return false; }
    if (target !== p.list && !p.list.contains(target)) return false;
    const items = usable(p.list), at = items.indexOf(activeOf(p.list));
    const go = (option) => { event.preventDefault(); if (option) setActive(p.list, option); return true; };
    switch (event.key) {
      case 'ArrowDown': return go(at < 0 ? items[0] : items[Math.min(items.length - 1, at + 1)]);
      case 'ArrowUp': return go(at < 0 ? items[items.length - 1] : items[Math.max(0, at - 1)]);
      case 'Home': case 'PageUp': return go(items[0]);
      case 'End': case 'PageDown': return go(items[items.length - 1]);
      case 'Enter': case ' ': event.preventDefault(); pick(openId, activeOf(p.list)); return true;
      case 'Escape': event.preventDefault(); event.stopPropagation(); close(true); return true;
      case 'Tab': close(true); return false;   // the focus goes on from the button, as the page's own Tab handling moves it
      default: break;
    }
    if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); typeAhead(p.list, event.key); return true; }
    return false;
  }
  function click(event) {
    const target = event.target;
    const button = target?.closest?.('.pip-picker-button');
    if (button) {
      if (!button.disabled) { if (openId === button.id) close(true); else open(button.id); }
      return true;
    }
    const option = target?.closest?.('.pip-picker-list [role=option]');
    if (option) {
      const id = option.closest('.pip-picker-list').id.replace(/-list$/, '');
      if (option.getAttribute('aria-disabled') === 'true') parts(id)?.list.focus({ preventScroll: true });
      else pick(id, option);
      return true;
    }
    if (openId) { const p = parts(openId); if (!p || !p.anchor.contains(target)) close(false); else return true; }
    return false;   // a click outside goes on to what it was on
  }
  // The row under the pointer is the one the keys are on, once the pointer moves: a list opening (or a dialog scrolling)
  // under a still pointer doesn't take the row the keys chose.
  let pointer = '';
  function hover(event) {
    const at = `${event.clientX},${event.clientY}`;
    if (at === pointer) return;
    pointer = at;
    if (!openId) return;
    const option = event.target?.closest?.('.pip-picker-list [role=option]'), p = parts(openId);
    if (p && option && p.list.contains(option) && option.getAttribute('aria-disabled') !== 'true' && activeOf(p.list) !== option) setActive(p.list, option, false);
  }
  // The focus leaving the open list for anything outside its dropdown closes it; a redraw taking the list away doesn't
  // (restore opens the new one).
  function focusout(event) {
    if (!openId || !event.target?.isConnected) return;
    const p = parts(openId);
    if (!p || event.target !== p.list) return;
    if (event.relatedTarget && p.anchor.contains(event.relatedTarget)) return;
    close(false);
  }
  // After the view is redrawn: a list that was open is open again, on the same row.
  function restore() {
    if (!openId) return;
    const id = openId, p = parts(id);
    if (!p || p.button.disabled) { openId = ''; return; }
    if (p.list.hidden) { const value = activeValue; openId = ''; open(id, { value }); }
  }
  return { open, close, restore, click, keydown, hover, focusout, isOpen: () => openId };
}
