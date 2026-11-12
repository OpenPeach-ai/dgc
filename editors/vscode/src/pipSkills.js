// pips-12: "Skills" on a Personal Pip's page (Pips API 88, get_pip_skills / set_pip_skill). One row a skill: its name,
// its one line, and a switch. Every skill is on until you switch it off on that Pip; switched off, the Pip is never
// offered it, and other Pips keep it.
import {infoTip} from './pipInfoTip.js';

const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
// Where a skill comes from, as DGC names it (dgc/pips.py personal_skills).
const FROM = { user: 'Yours', plugin: 'From a plugin', builtin: 'Comes with DGC' };

/** get_pip_skills' answer, checked: {pip_id, skills: [{name, description, source, on}]}, 200 at most. */
export function pipSkillsPage(value, pip) {
  const fail = () => { throw new Error('This Pip’s skills didn’t load. Refresh to try again.'); };
  if (!value || typeof value !== 'object' || value.pip_id !== pip || !Array.isArray(value.skills) || value.skills.length > 200) fail();
  const seen = new Set();
  return value.skills.map(s => {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !NAME.test(s.name) || seen.has(s.name) || typeof s.description !== 'string' || [...s.description].length > 300
      || typeof s.source !== 'string' || s.source.length > 40 || typeof s.on !== 'boolean') fail();
    seen.add(s.name);
    return { name: s.name, description: s.description.replace(/\s+/g, ' ').trim(), source: s.source, on: s.on };
  });
}

/** set_pip_skill's answer: {skill, on}, about the skill that was asked. */
export function pipSkillSwitched(value, skill, on) {
  if (!value || value.skill !== skill || value.on !== on) throw new Error('DGC answered about another skill. Refresh the Pip.');
  return on;
}

/** The section. `skills`: pipSkillsPage's list, or null while it loads. */
export function pipSkillsMarkup(skills, { esc, busy = false, error = '', pipName = 'This Pip' }) {
  const off = busy ? ' disabled' : '', name = esc(pipName);
  const head = `<section class="pip-page-group pip-skills" aria-label="Skills"><h3 class="pip-page-label">Skills${infoTip('pipSkillsSays', 'Skills',
    `Every skill is on until you switch it off here. Off, ${name} is never offered it. Other Pips are not changed.`)}</h3>`;
  const said = error ? `<p class="error" role="alert">${esc(error)}</p>` : '';
  if (!skills) return `${head}${said || '<p class="muted" role="status">Loading…</p>'}</section>`;
  if (!skills.length) return `${head}<p class="pip-page-empty">None yet. Have ${name} make one with /learn in its chat, or turn a plugin on in Settings → Plugins.</p>${said}</section>`;
  const row = (s, i) => {
    const sid = `pipSkill-${i}`, from = FROM[s.source] || '';
    const says = [from, s.on ? '' : `Off for ${name}`].filter(Boolean).join(' · ');
    return `<li class="pip-skill${s.on ? '' : ' is-off'}" data-pip-skill="${esc(s.name)}" data-on="${s.on}">`
      + `<div class="pip-page-row static"><span class="row-words"><strong>${esc(s.name)}</strong>`
      + (s.description ? `<small class="pip-skill-line" title="${esc(s.description)}">${esc(s.description)}</small>` : '')
      + (says ? `<small class="pip-skill-says" id="${sid}">${says}</small>` : '') + '</span>'
      + `<label class="switch" title="${s.on ? 'On' : 'Off'}"><input type="checkbox" role="switch" data-pip-skill-switch="${esc(s.name)}" aria-label="${esc(s.name)} for ${name}"${says ? ` aria-describedby="${sid}"` : ''}${s.on ? ' checked' : ''}${off}><span aria-hidden="true"></span></label></div></li>`;
  };
  return `${head}<ul class="pip-page-list pip-skills-list">${skills.map(row).join('')}</ul>${said}</section>`;
}
