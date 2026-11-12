// A Project Pip's owner session (0.52, asked 12 Nov; Pips API 89, dgc/pip_owners.py): the one Work chat its reports
// reach. Its Settings page says which ("Reports to"), by the title the editor's Work list shows, and Change opens a
// picker of the project's Work sessions plus "No session" (its reports then wait in the Pips view). A Personal Pip
// has its own chat and no such row.
import {infoTip} from './pipInfoTip.js';

export const OWNERS_API=89;
const SESSION=/^[A-Za-z0-9_-]{1,128}$/;
export const NO_SESSION='No session: its reports wait in the Pips view';

/** get_pip_owner's answer, checked: {pip_id, session_id (null: none), chosen}. */
export function pipOwner(value,pip){
  if(!value||typeof value!=='object'||value.pip_id!==pip||!(value.session_id===null||typeof value.session_id==='string'&&SESSION.test(value.session_id))||typeof value.chosen!=='boolean')
    throw new Error('This Pip’s owner session didn’t load. Refresh to try again.');
  return {session:value.session_id,chosen:value.chosen};
}
/** set_pip_owner's answer: about this Pip, and the session that was asked. */
export function pipOwnerSet(value,pip,session){
  if(!value||value.pip_id!==pip||(value.session_id??null)!==session)throw new Error('DGC answered about another Pip. Refresh the Pip.');
  return {session,chosen:true};
}
/** The editor's Work titles, as the host answers them: {sessions: [{id, title}]} -> Map id -> title. */
export function workTitles(value){
  const titles=new Map();
  for(const s of Array.isArray(value?.sessions)?value.sessions.slice(0,500):[])if(s&&typeof s.id==='string'&&SESSION.test(s.id)&&typeof s.title==='string'&&s.title.trim())titles.set(s.id,s.title.trim().slice(0,200));
  return titles;
}
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** What a session is called: the title the Work list shows, else when it is from (its id starts with its date and
 *  time), else that it has no title. Never its bare id. */
export function sessionWords(id,titles){
  const title=titles?.get?.(id);if(title)return title;
  const m=/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(String(id||''));
  if(m&&+m[2]>=1&&+m[2]<=12&&+m[3]>=1&&+m[3]<=31&&+m[4]<24&&+m[5]<60)return `Session from ${+m[3]} ${MONTHS[+m[2]-1]}, ${m[4]}:${m[5]}`;
  return 'A session with no title';
}
/** The row. `owner`: pipOwner's value, or null while it loads. `picker`: null (closed), or {sessions: [ids, newest
 *  first] | null while they load, error}. */
export function ownerMarkup(owner,{esc,titles,picker=null,busy=false,error='',pipName='This Pip'}){
  const name=esc(pipName),off=busy?' disabled':'';
  const head=`<section class="section pip-owner" aria-label="Reports to"><div class="section-head"><h2>Reports to${infoTip('pipOwnerSays','Reports to',
    `The one Work session ${name}’s reports come to. The Pips view and Home list them too, whichever it is.`)}</h2>`;
  const said=error?`<p class="error" role="alert">${esc(error)}</p>`:'';
  if(!owner)return `${head}</div>${said||'<p class="muted" role="status">Loading…</p>'}</section>`;
  const now=owner.session?`<p class="goal pip-owner-now" title="${esc(sessionWords(owner.session,titles))}">${esc(sessionWords(owner.session,titles))}</p>`:`<p class="muted pip-owner-now">${NO_SESSION}</p>`;
  if(!picker)return `${head}<div class="actions"><button type="button" id="pip-owner-change" class="quiet"${off}>Change</button></div></div>${now}${said}</section>`;
  const choice=(id,title,sub)=>`<li><button type="button" class="pip-owner-choice" role="radio" aria-checked="${(owner.session||'')===id}" data-owner-session="${esc(id)}"${off}>`
    +`<span class="pip-owner-mark" aria-hidden="true"></span><span class="pip-owner-words"><span class="pip-owner-title">${esc(title)}</span>${sub?`<small>${esc(sub)}</small>`:''}</span></button></li>`;
  const list=picker.sessions?`<ul class="pip-owner-list" role="radiogroup" aria-label="The session ${name} reports to">${picker.sessions.map(id=>choice(id,sessionWords(id,titles),'')).join('')}${choice('','No session','Its reports wait in the Pips view')}</ul>`
    :picker.error?'':'<p class="muted" role="status">Loading this project’s sessions…</p>';
  return `${head}</div>${now}${list}${picker.error?`<p class="error" role="alert">${esc(picker.error)}</p>`:''}${said}<div class="actions"><button type="button" id="pip-owner-cancel" class="quiet"${off}>Cancel</button></div></section>`;
}
