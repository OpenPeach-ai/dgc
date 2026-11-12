// pips-18: import a bot from a GitHub link, or from a Grok bot (Pips API 88; dgc/pip_import_sources.py).
// Two more rows in the Personal list's Teams menu, each with a small dialog:
//   Import from GitHub…: one link to a team file or a Pip's file → import_pip_source {source: "github", url}.
//   Bring a Grok bot…: Grok has no export, so DGC gives a prompt (get_pip_import_prompt → {prompt}) to paste into the
//   Grok bot, and you paste back what it writes → import_pip_source {source: "grok", text}.
// Either answers {setups, name, left_out}: one pending setup card per Pip, as a team file's import does. Nothing is
// created, and it has no keys and no app access, until each card is approved.
export const LINK_MAX = 2048, REPLY_MAX = 64 * 1024, PROMPT_MAX = 8000, IMPORT_MAX = 20, IMPORT_NAME_MAX = 80;
// The addresses DGC fetches a file from (pip_import_sources.raw_url): a file's page on github.com, or a raw file.
export const GITHUB_HOSTS = ['github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com'];
const LINK_SAYS = 'Paste an https link to a file on GitHub (github.com/…/blob/…, or its Raw address).';
const bytes = text => new TextEncoder().encode(text).length;

/** The link as typed, checked as the host checks it. Throws in plain words when it can't be one DGC reads. */
export function githubLink(text) {
  const link = String(text ?? '').trim();
  if (!link) throw new Error('Paste a GitHub link to a team file or a Pip file.');
  let url = null;
  try { url = new URL(link); } catch { /* said below */ }
  if (link.length > LINK_MAX || /\s/.test(link) || !url || url.protocol !== 'https:' || url.username || url.password || url.port || !GITHUB_HOSTS.includes(url.hostname.toLowerCase())) throw new Error(LINK_SAYS);
  return link;
}

/** What the Grok bot wrote, as pasted: something, and 64 KiB at most. DGC reads the JSON block in it. */
export function grokReply(text) {
  const reply = typeof text === 'string' ? text : '';
  if (!reply.trim()) throw new Error('Paste what your Grok bot wrote.');
  if (bytes(reply) > REPLY_MAX) throw new Error('That is longer than a Grok bot’s description should be (64 KiB at most).');
  return reply;
}

/** get_pip_import_prompt's answer, checked: {prompt}, the text to paste into a Grok bot. */
export function importPrompt(value) {
  if (!value || typeof value !== 'object' || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > PROMPT_MAX) throw new Error('DGC didn’t give the prompt as expected. Close this and try again.');
  return value.prompt;
}

const lines = (value, most = 8) => (Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.trim()).map(x => x.slice(0, 300)).slice(0, most) : []);

/** import_pip_source's answer, checked: {setups: [a pending setup card per Pip], name, left_out}. */
export function sourceImported(value) {
  const fail = () => { throw new Error('The import didn’t come back as expected. Refresh to see what was saved.'); };
  if (!value || typeof value !== 'object' || !Array.isArray(value.setups) || !value.setups.length || value.setups.length > IMPORT_MAX || typeof value.name !== 'string' || [...value.name].length > IMPORT_NAME_MAX) fail();
  const seen = new Set();
  for (const s of value.setups) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^setup_[a-f0-9]{32}$/.test(s.id) || seen.has(s.id) || typeof s.workspace_id !== 'string' || s.status !== 'pending') fail();
    seen.add(s.id);
  }
  return { name: value.name.replace(/\s+/g, ' ').trim() || 'A new Pip', setups: value.setups, left: lines(value.left_out) };
}

/**
 * The line over the cards. From GitHub: what was imported, how many cards wait here and elsewhere, and what was left
 * out. From a Grok bot: its one card, then DGC's own notes on it (its skills and routines, to add on its page).
 */
export function sourceImportedNotice(done, here, source) {
  const total = done.setups.length, away = total - here, one = total === 1;
  const from = source === 'grok' ? 'your Grok bot' : 'GitHub';
  return `Imported “${done.name}” from ${from}: ${one ? 'one new Pip' : `${total} new Pips`} to review. Nothing is created until you approve ${one ? 'it' : 'each one'}.`
    + (away ? ` ${away === total ? (away === 1 ? 'It is' : 'They are') : away === 1 ? 'One is' : `${away} are`} for this project: look under Project.` : '')
    + (done.left.length ? (source === 'grok' ? ' ' : ' Not included: ') + done.left.join(' ') : '');
}

/** Import from GitHub…: the dialog's body. One link, and which addresses work. */
export function githubImportMarkup({ esc, url = '', busy = false }) {
  return `<label for="importLink">Link to the file<input id="importLink" data-draft="importLink" type="url" inputmode="url" maxlength="${LINK_MAX}" autocomplete="off" spellcheck="false"`
    + ` placeholder="https://github.com/…" aria-describedby="import-link-says" value="${esc(url)}"${busy ? ' disabled' : ''}></label>`
    + `<p class="muted import-says" id="import-link-says">Use the address of the file’s page on github.com, or its Raw address (raw.githubusercontent.com or gist.githubusercontent.com). `
    + `DGC reads that one file, up to 256 KiB, and nothing else. Each Pip in it waits for your OK, with no keys and no app access.</p>`;
}

/** Bring a Grok bot…: the dialog's body. The prompt to copy (read-only), then a box for what the bot writes back. */
export function grokImportMarkup({ esc, prompt = '', reply = '', copied = false, busy = false }) {
  const off = busy ? ' disabled' : '';
  const first = prompt
    ? `<textarea id="importPrompt" class="import-prompt" readonly rows="6" aria-labelledby="import-step-1" spellcheck="false">${esc(prompt)}</textarea>`
      + `<span class="import-copy"><button type="button" id="import-prompt-copy" class="quiet pill">${copied ? 'Copied' : 'Copy'}</button><span class="muted" id="import-copied" role="status">${copied ? 'Now paste it into your Grok bot.' : ''}</span></span>`
    : `<p class="muted" id="import-prompt-wait" role="status">Getting the prompt…</p>`;
  return `<div class="import-step"><p class="import-step-says" id="import-step-1"><span class="import-step-n" aria-hidden="true">1</span>Paste this prompt into your Grok bot, then paste its reply below.</p>${first}</div>`
    + `<div class="import-step"><label for="importReply"><span class="import-step-says"><span class="import-step-n" aria-hidden="true">2</span>Its reply</span>`
    + `<textarea id="importReply" data-draft="importReply" class="import-reply" rows="5" spellcheck="false" placeholder="Paste what your Grok bot wrote"${off}>${esc(reply)}</textarea></label></div>`
    + `<p class="muted import-says">It becomes one new Pip that waits for your OK, with no keys and no app access. Its skills and routines come as notes, to add on its page.</p>`;
}
