// A Personal Pip's routines (pip_routines), Grok's Routines: something it does on its own, at a time,
// when a matching email arrives, or before a calendar event. You add and edit them in its Settings;
// the Pip may suggest one in its chat, and the card under its message is your Add routine / Not now.

const STATUSES = ['suggested', 'on', 'off'];
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const RECENT_MS = 30 * 60 * 1000;
const text = (v, max) => typeof v === 'string' && v.length <= max;
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const pad = n => String(n).padStart(2, '0');
/** "Wed 8 Oct, 18:52": a routine's times, short and in the user's own clock. */
export function shortDate(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function routine(value, pip) {
  const fail = () => { throw new Error('This routine didn’t load. Refresh to try again.'); };
  if (!record(value) || !/^routine_[a-f0-9]{32}$/.test(value.id) || value.pip_id !== pip || !text(value.title, 160) || !value.title
    || !text(value.prompt, 4000) || !STATUSES.includes(value.status) || !['user', 'pip'].includes(value.created_by)
    || !record(value.trigger) || !['schedule', 'email', 'calendar'].includes(value.trigger.kind)
    || !(value.run_id === null || value.run_id === undefined || /^run_[A-Za-z0-9]{1,64}$/.test(value.run_id))
    || !(value.next_due_at === null || time(value.next_due_at)) || !(value.last_run_at === null || time(value.last_run_at))
    || !(value.last_error === null || text(value.last_error, 600)) || !time(value.updated_at)) fail();
  if (value.trigger.kind === 'schedule' && !record(value.trigger.schedule)) fail();
  return value;
}

export function routinesPage(value, pip) {
  if (!record(value) || value.pip_id !== pip || !Array.isArray(value.routines) || value.routines.length > 20) {
    throw new Error('Its routines didn’t load. Refresh to try again.');
  }
  return value.routines.map(r => routine(r, pip));
}

/** When it runs, in words. */
export function routineWhen(trigger, formatDate = v => new Date(v).toLocaleString()) {
  if (trigger.kind === 'email') return `When an email matching “${trigger.query}” arrives`;
  if (trigger.kind === 'calendar') return `${trigger.lead_minutes} minutes before each calendar event`;
  const s = trigger.schedule;
  if (s.type === 'daily') return `Every day at ${s.time}`;
  if (s.type === 'interval') return s.minutes === 60 ? 'Every hour' : s.minutes % 60 === 0 ? `Every ${s.minutes / 60} hours` : `Every ${s.minutes} minutes`;
  if (s.type === 'once') return `Once, ${shortDate(s.at)}`;
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (1-5|[0-6])$/.exec(s.cron || '');
  if (m) return `${m[3] === '1-5' ? 'Weekdays' : `${WEEKDAYS[Number(m[3])]}`} at ${pad(m[2])}:${pad(m[1])}`;
  return `On the schedule ${s.cron}`;
}

/** The form's fields for a routine (a new one when there is none). */
export function routineDraft(value = null, zone = 'UTC') {
  const d = { routineId: value?.id || '', routineTitle: value?.title || '', routinePrompt: value?.prompt || '', routineKind: 'daily',
    routineTime: '09:00', routineDay: '1', routineHours: '3', routineAt: '', routineQuery: '', routineLead: '15', routineZone: zone };
  const t = value?.trigger;
  if (!t) return d;
  if (t.kind === 'email') return { ...d, routineKind: 'email', routineQuery: t.query };
  if (t.kind === 'calendar') return { ...d, routineKind: 'calendar', routineLead: String(t.lead_minutes) };
  const s = t.schedule;
  if (s.timezone) d.routineZone = s.timezone;
  if (s.type === 'daily') return { ...d, routineKind: 'daily', routineTime: s.time };
  if (s.type === 'interval') return { ...d, routineKind: 'hours', routineHours: String(Math.max(1, Math.round(s.minutes / 60))) };
  if (s.type === 'once') { const at = new Date(s.at); return { ...d, routineKind: 'once', routineAt: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}` }; }
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (1-5|[0-6])$/.exec(s.cron || '');
  if (m) return { ...d, routineKind: m[3] === '1-5' ? 'weekdays' : 'weekly', routineTime: `${pad(m[2])}:${pad(m[1])}`, routineDay: m[3] === '1-5' ? '1' : m[3] };
  return { ...d, routineKind: 'custom' };
}

/** The routine the form describes, or a sentence saying what to fix. */
export function routineFromDraft(d, now = Date.now()) {
  const title = String(d.routineTitle || '').trim(), prompt = String(d.routinePrompt || '').trim();
  if (!title) throw new Error('Give the routine a name.');
  if (title.length > 160) throw new Error('Keep its name under 160 characters.');
  if (!prompt) throw new Error('Say what it should do.');
  if (prompt.length > 4000) throw new Error('Keep what it should do under 4,000 characters.');
  const zone = String(d.routineZone || 'UTC');
  const clock = () => { const t = String(d.routineTime || ''); if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error('Choose a time.'); return t.split(':').map(Number); };
  let trigger;
  switch (d.routineKind) {
    case 'daily': clock(); trigger = { kind: 'schedule', schedule: { type: 'daily', time: d.routineTime, timezone: zone, missed_policy: 'coalesce_latest', dst_policy: 'skip_gap_first_fold' } }; break;
    case 'weekdays': case 'weekly': {
      const [h, m] = clock(), day = d.routineKind === 'weekdays' ? '1-5' : String(d.routineDay);
      if (!/^(?:1-5|[0-6])$/.test(day)) throw new Error('Choose a day.');
      trigger = { kind: 'schedule', schedule: { type: 'cron', cron: `${m} ${h} * * ${day}`, timezone: zone, missed_policy: 'coalesce_latest', dst_policy: 'skip_gap_first_fold' } }; break;
    }
    case 'hours': {
      const hours = Number(d.routineHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('Choose every 1 to 168 hours.');
      trigger = { kind: 'schedule', schedule: { type: 'interval', minutes: hours * 60, missed_policy: 'coalesce_latest' } }; break;
    }
    case 'once': {
      const at = Date.parse(String(d.routineAt || ''));
      if (!Number.isFinite(at)) throw new Error('Choose the date and time.');
      if (at <= now) throw new Error('Choose a time in the future.');
      trigger = { kind: 'schedule', schedule: { type: 'once', at: new Date(at).toISOString(), missed_policy: 'coalesce_latest' } }; break;
    }
    case 'email': {
      const query = String(d.routineQuery || '').trim();
      if (!query) throw new Error('Say which emails, as a Gmail search such as from:alerts@bank.com.');
      if (query.length > 300 || /[\u0000-\u001f\u007f]/.test(query)) throw new Error('Keep the Gmail search to one line, under 300 characters.');
      trigger = { kind: 'email', query, every_minutes: 10 }; break;
    }
    case 'calendar': {
      const lead = Number(d.routineLead);
      if (!Number.isInteger(lead) || lead < 5 || lead > 120) throw new Error('Choose 5 to 120 minutes before.');
      trigger = { kind: 'calendar', lead_minutes: lead, every_minutes: 10 }; break;
    }
    default: throw new Error('Choose when it runs.');
  }
  return { title, prompt, trigger };
}

/** The cards worth showing in its chat: suggestions waiting for you, and one you just added. */
export function shownRoutineCards(routines, now = Date.now()) {
  return (routines || []).filter(r => r.created_by === 'pip' && (r.status === 'suggested'
    || r.status === 'on' && now - Date.parse(r.updated_at) < RECENT_MS && Date.parse(r.updated_at) > Date.parse(r.created_at)));
}

const mark = '<span class="app-link-mark routine-mark" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v2.8h-2.8"/><path d="M8 5v3.2l2 1.3"/></svg></span>';

/** A routine the Pip suggested, under its message: Add routine or Not now. */
export function routineCardMarkup(r, { esc, busy = false, formatDate }) {
  const id = esc(r.id), off = busy ? ' disabled' : '', when = esc(routineWhen(r.trigger, formatDate));
  const head = (title, sub) => `<div class="app-link-head">${mark}<div class="app-link-words"><strong>${title}</strong><small>${sub}</small></div></div>`;
  if (r.status === 'on') return `<div class="app-link routine-card" data-routine-card="${id}" data-state="on" role="group" aria-label="Routine added">${head(`Routine added: ${esc(r.title)}`, `${when}. Change it in Settings.`)}</div>`;
  return `<div class="app-link routine-card" data-routine-card="${id}" data-state="suggested" role="group" aria-label="Add this routine?">`
    + head(`Add this routine? ${esc(r.title)}`, when)
    + `<p class="routine-prompt">${esc(r.prompt)}</p>`
    + `<div class="app-link-actions"><button type="button" class="primary" data-routine-add="${id}"${off}>${busy ? 'Adding…' : 'Add routine'}</button>`
    + `<button type="button" class="quiet" data-routine-decline="${id}"${off}>Not now</button></div></div>`;
}

/** Its routines in Settings: one row each with an on/off switch, then Add routine. */
export function routinesMarkup(routines, { esc, busy = false, editing = '', form = '', formatDate, pipName = 'It', schedule = '' }) {
  const off = busy ? ' disabled' : '';
  const shown = (routines || []).filter(r => r.status !== 'suggested');
  const rows = shown.map(r => editing === r.id ? form : `<li class="routine-row" data-state="${esc(r.status)}">`
    + `<button type="button" class="routine-open" data-routine-edit="${esc(r.id)}"${off}>${mark}<span class="routine-words"><strong>${esc(r.title)}</strong>`
    + `<small>${esc(routineWhen(r.trigger, formatDate))}${r.status === 'on' && r.next_due_at && r.trigger.kind === 'schedule' && r.trigger.schedule.type !== 'once' ? ` · next ${esc(shortDate(r.next_due_at))}` : ''}</small>`
    + `${r.last_error ? `<small class="routine-error">${esc(r.last_error)}</small>` : ''}</span></button>`
    + `<label class="switch" title="${r.status === 'on' ? 'On' : 'Off'}"><input type="checkbox" role="switch" data-routine-toggle="${esc(r.id)}"${r.status === 'on' ? ' checked' : ''}${off} aria-label="${esc(r.title)} ${r.status === 'on' ? 'on' : 'off'}"><span aria-hidden="true"></span></label></li>`).join('');
  const legacy = schedule ? `<li class="routine-row legacy"><span class="routine-open static">${mark}<span class="routine-words"><strong>Its task</strong><small>${esc(schedule)}</small></span></span><button type="button" class="quiet" data-routine-legacy${off}>Change</button></li>` : '';
  const empty = !shown.length && !schedule && editing !== 'new' ? `<p class="routine-empty">No routines yet. A routine is something ${esc(pipName)} does on its own: every morning, when an email arrives, or before a meeting.</p>` : '';
  return `<ul class="routine-list">${legacy}${rows}${editing === 'new' ? form : ''}</ul>${empty}`
    + (editing === 'new' || shown.length >= 10 ? '' : `<button type="button" class="routine-add" data-routine-new${off}>+ Add routine</button>`);
}

/** Add or edit one routine. */
export function routineFormMarkup(d, { esc, busy = false, error = '', gmail = false, calendar = false, isNew = true }) {
  const off = busy ? ' disabled' : '';
  const kinds = [['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week'], ['hours', 'Every few hours'], ['once', 'Once'],
    ['email', 'When an email arrives'], ['calendar', 'Before calendar events'], ...(d.routineKind === 'custom' ? [['custom', 'Its current schedule']] : [])];
  const at = ['daily', 'weekdays', 'weekly'].includes(d.routineKind)
    ? `${d.routineKind === 'weekly' ? `<select id="routineDay" data-draft="routineDay" aria-label="Day"${off}>${WEEKDAYS.map((w, i) => `<option value="${i}"${String(d.routineDay) === String(i) ? ' selected' : ''}>${w.slice(0, -1)}</option>`).join('')}</select>` : ''}<label class="inline">at <input id="routineTime" data-draft="routineTime" type="time" step="60" value="${esc(d.routineTime)}"${off}></label>`
    : d.routineKind === 'hours' ? `<label class="inline">every <input id="routineHours" data-draft="routineHours" type="number" min="1" max="168" step="1" value="${esc(d.routineHours)}"${off}> hours</label>`
    : d.routineKind === 'once' ? `<input id="routineAt" data-draft="routineAt" type="datetime-local" value="${esc(d.routineAt)}" aria-label="Date and time"${off}>`
    : d.routineKind === 'email' ? `<input id="routineQuery" data-draft="routineQuery" maxlength="300" placeholder="from:alerts@bank.com" value="${esc(d.routineQuery)}" aria-label="Which emails (a Gmail search)"${off}>`
    : d.routineKind === 'calendar' ? `<label class="inline"><input id="routineLead" data-draft="routineLead" type="number" min="5" max="120" step="5" value="${esc(d.routineLead)}"${off}> minutes before</label>` : '';
  const note = d.routineKind === 'email' ? (gmail ? 'It looks every 10 minutes. Emails that are already there don’t count.' : 'Needs Gmail. Ask it in the chat to connect Gmail; the routine waits until then.')
    : d.routineKind === 'calendar' ? (calendar ? 'It looks every 10 minutes and runs once per event.' : 'Needs Google Calendar. Ask it in the chat to connect it; the routine waits until then.')
    : ['daily', 'weekdays', 'weekly'].includes(d.routineKind) ? `Times are in ${esc(d.routineZone)}.` : d.routineKind === 'custom' ? 'Choose a new time to change it.' : '';
  return `<li class="routine-form-row"><form id="routine-form" class="routine-form form">`
    + `<label for="routineTitle">Name</label><input id="routineTitle" data-draft="routineTitle" maxlength="160" placeholder="Morning brief" value="${esc(d.routineTitle)}"${off}>`
    + `<label for="routinePrompt">What it does</label><textarea id="routinePrompt" data-draft="routinePrompt" rows="3" maxlength="4000" placeholder="Check my calendar and the weather, and tell me what today looks like."${off}>${esc(d.routinePrompt)}</textarea>`
    + `<label for="routineKind">When</label><div class="routine-when"><select id="routineKind" data-draft="routineKind"${off}>${kinds.map(([k, l]) => `<option value="${k}"${d.routineKind === k ? ' selected' : ''}>${l}</option>`).join('')}</select>${at}</div>`
    + (note ? `<p class="muted">${note}</p>` : '') + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '')
    + `<div class="actions"><button type="submit" class="primary"${off}>${isNew ? 'Add routine' : 'Save'}</button><button type="button" class="quiet" data-routine-cancel${off}>Cancel</button>`
    + `${isNew ? '' : `<button type="button" class="quiet danger" data-routine-delete="${esc(d.routineId)}"${off}>Delete</button>`}</div></form></li>`;
}
