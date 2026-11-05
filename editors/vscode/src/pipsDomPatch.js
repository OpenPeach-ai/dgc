// Keep the Pip chat mounted while its stream, runner, and unread state refresh.
// Replacing #app.innerHTML tears down the selection and restarts every face's
// animation, even when the rendered message has not changed.
function key(node) {
  if (node.nodeType !== 1) return '';
  for (const name of ['id', 'data-message', 'data-run-post', 'data-view', 'data-avatar-key']) {
    const value = node.getAttribute(name);
    if (value) return `${name}:${value}`;
  }
  if (node.classList.contains('conversation-log')) return 'class:conversation-log';
  if (node.classList.contains('pip-conversation')) return 'class:pip-conversation';
  if (node.classList.contains('pip-topbar')) return 'class:pip-topbar';
  return '';
}

function compatible(current, next) {
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) return false;
  const a = key(current), b = key(next);
  return a === b;
}

function patchNode(current, next) {
  if (current.nodeType === 3 || current.nodeType === 8) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  // Plush rigs have live eye tracking and animation classes. Their markup is
  // deterministic for a given pose, so leave the running rig intact.
  if (current.hasAttribute('data-avatar-key') &&
      ['data-avatar-key', 'data-character', 'data-pose'].every(
        name => current.getAttribute(name) === next.getAttribute(name))) return;
  if (current.outerHTML === next.outerHTML) return;
  for (const attr of [...current.attributes]) {
    if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  }
  for (const attr of [...next.attributes]) {
    if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  }
  patchChildren(current, next);
  if (current.nodeName === 'TEXTAREA' && current.value !== next.value) current.value = next.value;
}

export function patchChildren(current, next) {
  let cursor = current.firstChild;
  for (const wanted of [...next.childNodes]) {
    let found = cursor && compatible(cursor, wanted) ? cursor : null;
    const wantedKey = key(wanted);
    if (!found && wantedKey) {
      for (let candidate = cursor?.nextSibling; candidate; candidate = candidate.nextSibling) {
        if (compatible(candidate, wanted)) { found = candidate; break; }
      }
    }
    if (!found) {
      found = wanted.cloneNode(true);
      current.insertBefore(found, cursor);
    } else {
      if (found !== cursor) current.insertBefore(found, cursor);
      patchNode(found, wanted);
    }
    cursor = found.nextSibling;
  }
  while (cursor) {
    const obsolete = cursor;
    cursor = cursor.nextSibling;
    obsolete.remove();
  }
}
