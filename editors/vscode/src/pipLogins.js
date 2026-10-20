// Saved logins (Pips API 56): a site's username, password and authenticator key, kept sealed by DGC on this computer and
// typed into the page by DGC when the Pip signs in. The Pip never sees them, and neither does this page after you save:
// it lists where each login fills, its username, that it has a code (never the key), and which Pips may use it.
//
// The form never keeps what you type: it is read from its boxes once, on Save, sent to DGC, and the boxes are emptied.
// Nothing of it goes in the chat, its draft, the view's saved state or a request history.

const MAX_FIELD = 512;
const BASE32 = /^[A-Z2-7]+=*$/;

/** Its page: the logins it may use, each with who may use it and Remove; the ones saved for other Pips; Save a login…. */
export function loginsMarkup(logins, {esc, busy = false, error = '', pipId = '', pipName = 'It', names = {}, confirm = ''}) {
  const off = busy ? ' disabled' : '';
  const head = `<section class="pip-page-group" aria-label="Logins"><h3 class="pip-page-label">Logins</h3>`;
  if (!logins) return `${head}${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}</section>`;
  const mine = logins.filter(l => l.usable), others = logins.filter(l => !l.usable);
  const named = id => id === pipId ? pipName : names[id] || 'another Pip';
  const pipsWords = list => list.length <= 3 ? list.map(named).join(list.length === 2 ? ' and ' : ', ')
    : `${list.slice(0, 2).map(named).join(', ')} and ${list.length - 2} more`;
  const who = l => l.pips === 'all' ? 'All your Pips' : l.pips.length === 1 ? `Only ${named(l.pips[0])}` : pipsWords(l.pips);
  const row = l => {
    const bits = [l.username || 'No username', l.has_code ? 'Fills its code too' : '', who(l)].filter(Boolean).map(esc).join(' · ');
    const removing = confirm === l.id
      ? `<span class="note-confirm">Remove it? <button type="button" class="quiet pill danger-text" data-login-remove="${esc(l.id)}"${off}>Remove</button><button type="button" class="quiet pill" data-login-keep="1"${off}>Keep it</button></span>`
      : `<button type="button" class="quiet pill" data-login-ask-remove="${esc(l.id)}" aria-label="Remove the login for ${esc(l.site)}"${off}>Remove</button>`;
    return `<li class="pip-page-row static login-row" data-login="${esc(l.id)}"><span class="row-words"><span>${esc(l.site)}</span><small>${bits}</small></span>`
      + `<label class="login-all"><input type="checkbox" data-login-all="${esc(l.id)}"${l.pips === 'all' ? ' checked' : ''}${off}> All Pips</label>${removing}</li>`;
  };
  const other = l => `<li class="pip-page-row static login-row sub" data-login="${esc(l.id)}"><span class="row-words"><span>${esc(l.site)}</span><small>${esc(l.username || 'No username')} · saved for ${esc(pipsWords(l.pips))}</small></span>`
    + `<button type="button" class="quiet pill" data-login-share="${esc(l.id)}"${off}>Let ${esc(pipName)} use it</button></li>`;
  return head
    + (mine.length ? `<ul class="pip-page-list">${mine.map(row).join('')}</ul>`
      : `<p class="pip-page-empty">None yet. When ${esc(pipName)} meets a sign-in page, its chat offers to save that site’s login, so it can sign in by itself. DGC types it in; ${esc(pipName)} never sees it.</p>`)
    + (others.length ? `<h3 class="pip-page-label">Saved for your other Pips</h3><ul class="pip-page-list">${others.map(other).join('')}</ul>` : '')
    + `<div class="pip-page-row static"><span class="row-words"><small>Kept sealed on this computer only: never in a chat, an export or a shared Pip.</small></span><button type="button" class="quiet pill" data-login-new="1"${off}>Save a login…</button></div>`
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

/** The dialog's body. From a card the site is fixed (where the Pip met the sign-in page); from the page, you type it. */
export function loginFormMarkup({esc, site = '', shown = '', fixed = false, pipName = 'It', busy = false}) {
  const off = busy ? ' disabled' : '';
  return `<form id="login-form" class="login-form" autocomplete="off" novalidate>`
    + (fixed ? `<p class="login-site"><span class="muted">Site</span> <strong>${esc(site)}</strong>${shown && shown !== site ? ` <span class="muted">(${esc(shown)})</span>` : ''}</p>`
      : `<label for="loginSite">Site<input id="loginSite" name="site" maxlength="2048" spellcheck="false" autocapitalize="off" placeholder="example.com" value="${esc(site)}"${off}></label>`)
    + `<label for="loginUser">Username or email<input id="loginUser" name="username" maxlength="${MAX_FIELD}" autocomplete="off" spellcheck="false" autocapitalize="off"${off}></label>`
    + `<label for="loginPassword">Password<input id="loginPassword" name="password" type="password" maxlength="${MAX_FIELD}" autocomplete="new-password"${off}></label>`
    + `<label for="loginCode"><span>Authenticator key <span class="muted">(optional)</span></span><input id="loginCode" name="totp" type="password" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="The setup key, or an otpauth:// link"${off}></label>`
    + `<p class="muted login-help">With the key, ${esc(pipName)} fills the site’s 6-digit code too. It’s the key the site shows when you add an authenticator app (“can’t scan the code?”).</p>`
    + `<label class="login-all-row"><input id="loginAll" type="checkbox"${off}> Let all my Pips use it</label>`
    + `<p class="muted login-help">DGC keeps it sealed on this computer and types it in for ${esc(pipName)}; ${esc(pipName)} never sees it, and it never goes in the chat.</p>`
    + `<p class="error" role="alert" id="login-error" hidden></p>`
    + `<div class="actions"><button type="button" id="review-cancel">Cancel</button><button type="submit" id="login-save" class="primary"${off}>Save login</button></div></form>`;
}

/** What the boxes hold, read once. A problem is said in words that never repeat what was typed. */
export function readLoginForm(root, fixed) {
  const value = id => root.querySelector('#' + id)?.value ?? '';
  const out = {username: value('loginUser').trim(), password: value('loginPassword'), totp: value('loginCode').trim(),
    all: root.querySelector('#loginAll')?.checked === true};
  if (!fixed) out.site = value('loginSite').trim();
  return out;
}
export function loginFormProblem(values, fixed) {
  if (!fixed && !values.site) return 'Type the site’s address, such as example.com.';
  if (!fixed && (/\s/.test(values.site) || values.site.length > 2048)) return 'Type the site’s address, such as example.com.';
  if (values.username.length > MAX_FIELD) return 'The username is too long.';
  if (!values.password) return 'Type the password.';
  if (values.password.length > MAX_FIELD || /[\r\n]/.test(values.password)) return 'The password is too long or has a line break in it.';
  if (values.totp) {
    const key = values.totp.replace(/[\s-]/g, '').toUpperCase();
    if (!/^otpauth:\/\/totp\//i.test(values.totp) && !(BASE32.test(key) && key.replace(/=+$/, '').length >= 16))
      return 'That isn’t an authenticator key: it’s letters A–Z and digits 2–7, or an otpauth://totp/ link.';
  }
  return '';
}
/** Empty every box: after a save, a cancel, or the dialog closing. */
export function clearLoginForm(root) {
  for (const box of root?.querySelectorAll?.('#login-form input') || []) {
    if (box.type === 'checkbox') box.checked = false; else box.value = '';
  }
}
