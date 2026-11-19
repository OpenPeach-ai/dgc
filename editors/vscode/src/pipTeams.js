// pips-12: a whole team as one file (Pips API 88).
// A team file (format dgc-team) is up to 20 Pips' jobs under the team's name; importing one makes one setup card per
// Pip, nothing created until each is approved (dgc/pip_share.py). The host saves and reads the file: the page never
// handles a path. (The Personal list's folders that came with it were dropped before release, 0.52: the Pips page is
// one list, and its filter line shows one project folder's Pips.)

export const TEAM_MAX = 20, TEAM_NAME_MAX = 80;
// The Pips whose job can be shared (dgc/pip_share.py): not your Primary Pip, and not Patch.
const TEAM_TYPES = ['scout', 'lens', 'rook', 'lock', 'quill', 'pulse'];
const count = n => `${n} ${n === 1 ? 'Pip' : 'Pips'}`;

/** The Pips a team file can hold, from the list: live ones whose job can be shared. */
export function teamPips(pips) {
  return (pips || []).filter(p => p && p.status !== 'archived' && TEAM_TYPES.includes(p.pip_type));
}

/** What the Export team dialog says about how many are ticked, and whether it can go. */
export function teamCount(ticked) {
  if (!ticked) return { ok: false, says: 'Tick at least one Pip.' };
  if (ticked > TEAM_MAX) return { ok: false, says: `${ticked} ticked. A team file holds up to ${TEAM_MAX}: untick ${ticked - TEAM_MAX}.` };
  return { ok: true, says: `${count(ticked)} in this team.` };
}

/** The Export team dialog's body: the team's name, and one tick a Pip. `ticked`: a Set of Pip ids. */
export function teamExportMarkup({ esc, pips, ticked, name = '', left = 0, busy = false, face = () => '' }) {
  const off = busy ? ' disabled' : '', said = teamCount(pips.filter(p => ticked.has(p.id)).length);
  const rows = pips.map(p => `<li><label class="team-pip"><input type="checkbox" data-team-pip="${esc(p.id)}"${ticked.has(p.id) ? ' checked' : ''}${off}>${face(p)}<span class="team-pip-words"><strong>${esc(p.name)}</strong></span></label></li>`).join('');
  return `<label for="teamName">Team’s name<input id="teamName" data-draft="teamName" maxlength="${TEAM_NAME_MAX}" autocomplete="off" placeholder="My team" value="${esc(name)}"${off}></label>`
    + `<fieldset class="team-pips"><legend>Pips in the file</legend><ul class="team-pip-list">${rows}</ul></fieldset>`
    + `<p class="team-count${said.ok ? '' : ' is-stop'}" id="team-count" role="status">${esc(said.says)}</p>`
    + `<p class="muted">The file holds each Pip’s job: its name, instructions and schedule. Your accounts, memory, chats and results stay here.`
    + (left ? ` ${left === 1 ? 'One Pip isn’t' : `${left} Pips aren’t`} listed: your Primary Pip and Patch Pips can’t be shared.` : '') + '</p>';
}

/** export_pip_team's request, from the dialog: the ticked Pips in list order, and the name as typed. */
export function teamExportRequest(pips, ticked, name) {
  const pip_ids = pips.filter(p => ticked.has(p.id)).map(p => p.id);
  const said = teamCount(pip_ids.length);
  if (!said.ok) throw new Error(said.says);
  return { pip_ids, name: String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, TEAM_NAME_MAX) };
}

const lines = (value, most = 8) => (Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.trim()).map(x => x.slice(0, 300)).slice(0, most) : []);

/** What the host answers once a team file is saved: {saved, file, name, count, left_out}, or {cancelled}. */
export function teamExported(value) {
  if (value && value.cancelled === true) return null;
  if (!value || typeof value !== 'object' || value.saved !== true || typeof value.name !== 'string' || !Number.isInteger(value.count) || value.count < 1 || value.count > TEAM_MAX
    || typeof value.file !== 'string' || !/^[^/\\\u0000]{1,255}$/.test(value.file)) throw new Error('The team file didn’t save as expected. Export again.');
  return { name: value.name.slice(0, TEAM_NAME_MAX), count: value.count, file: value.file, left: lines(value.left_out) };
}

/** import_pip_team's answer, checked: {setups: [a pending setup card per Pip], name, left_out}; or null when cancelled. */
export function teamImported(value) {
  if (value && value.cancelled === true) return null;
  const fail = () => { throw new Error('The team didn’t import as expected. Refresh to see what was saved.'); };
  if (!value || typeof value !== 'object' || !Array.isArray(value.setups) || !value.setups.length || value.setups.length > TEAM_MAX || typeof value.name !== 'string' || [...value.name].length > TEAM_NAME_MAX) fail();
  const seen = new Set();
  for (const s of value.setups) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^setup_[a-f0-9]{32}$/.test(s.id) || seen.has(s.id) || typeof s.workspace_id !== 'string' || s.status !== 'pending') fail();
    seen.add(s.id);
  }
  return { name: value.name.replace(/\s+/g, ' ').trim() || 'My team', setups: value.setups, left: lines(value.left_out) };
}

/** The line that names an exported team and what stayed behind. */
export function teamExportedNotice(done) {
  return `Saved the team “${done.name}” (${count(done.count)}) as ${done.file}.` + (done.left.length ? ' Not included: ' + done.left.join(' ') : '');
}

/** The line that names an imported team: how many cards wait here, how many elsewhere, and what was left out. */
export function teamImportedNotice(done, here) {
  const total = done.setups.length, away = total - here;
  return `Imported the team “${done.name}”: ${total === 1 ? 'one new Pip' : `${total} new Pips`} to review. Nothing is created until you approve each one.`
    + (away ? ` ${away === total ? (away === 1 ? 'It is' : 'They are') : away === 1 ? 'One is' : `${away} are`} for this project: look under Project.` : '')
    + (done.left.length ? ' Not included: ' + done.left.join(' ') : '');
}
