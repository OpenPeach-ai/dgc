// Where a Pip's reports go, and the dashboards it keeps current (artifact_pips, Pips API 67), in its settings. A reviewing
// Pip's report is a card in its chat, as always; it can also be the newest version of that Pip's own document or
// spreadsheet, so every review is a version beside the others. Any Pip can be given dashboards: it refreshes them after
// every run it finishes, so a Pulse keeps one current on its schedule. Set on this computer only. Plain words: one
// choice with its one line, and a short list with Add and Remove. Two layouts: a reviewing Pip's Settings tab (its
// sections, as "When it runs" and "Model" are) and a Personal Pip's page (its grouped rows, as "Seeing" is).

export const REPORT_AS = ['chat', 'doc', 'sheet'];
export const MAX_DASHBOARDS = 8;
const ARTIFACT = /^ar_[a-f0-9]{16}$/;
const REPORT_NAMES = {chat: 'In its chat', doc: 'Also as a document', sheet: 'Also as a spreadsheet'};

/** get_pip_artifacts' (and set_pip_artifacts') answer, checked. */
export function pipArtifacts(value) {
  const fail = () => { throw new Error('Its reports and dashboards didn’t load. Refresh to try again.'); };
  const a = value?.artifacts;
  if (!a || typeof a !== 'object' || !REPORT_AS.includes(a.report_as) || !Array.isArray(a.dashboards) || a.dashboards.length > MAX_DASHBOARDS
    || a.dashboards.some(d => typeof d !== 'string' || !ARTIFACT.test(d))
    || ![a.report_doc, a.report_sheet].every(x => x === '' || (typeof x === 'string' && ARTIFACT.test(x)))) fail();
  // Its title and version, when the runtime says them; an older answer had ids only, and the page still says "Open".
  const title = v => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const version = v => Number.isSafeInteger(v) && v > 0 ? v : 0;
  return {report_as: a.report_as, dashboards: [...new Set(a.dashboards)], report_doc: a.report_doc, report_sheet: a.report_sheet,
    report_doc_title: title(a.report_doc_title), report_doc_version: version(a.report_doc_version),
    report_sheet_title: title(a.report_sheet_title), report_sheet_version: version(a.report_sheet_version)};
}

/** The document or sheet its reports are kept in now: {id, title, version}, or null. */
function madeReport(state) {
  if (state.report_as !== 'doc' && state.report_as !== 'sheet') return null;
  const id = state[`report_${state.report_as}`];
  return id ? {id, title: state[`report_${state.report_as}_title`] || '', version: state[`report_${state.report_as}_version`] || 0} : null;
}

/** The person's dashboards (list_artifact_dashboards, which the editor answers from its artifacts), checked. */
export function dashboardList(value) {
  if (!value || !Array.isArray(value.dashboards) || value.dashboards.length > 500) throw new Error('Your dashboards didn’t load. Refresh to try again.');
  return value.dashboards.filter(d => d && ARTIFACT.test(String(d.id || '')) && typeof d.title === 'string').map(d => ({
    id: d.id, title: d.title.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Dashboard',
    version: Number.isSafeInteger(d.version) && d.version > 0 ? d.version : 1}));
}

/** What the chosen place means, in one line. */
export function reportSays(state) {
  if (state.report_as === 'chat') return 'Each review’s findings come as a card in its chat.';
  const kind = state.report_as === 'doc' ? 'document' : 'spreadsheet';
  const made = madeReport(state);
  if (!made) return `The card still comes, and each review is also the newest version of its own ${kind}. It’s made after its next review.`;
  const reviews = made.version ? `, which holds ${made.version === 1 ? 'one review' : `${made.version} reviews`}` : '';
  return `The card still comes, and each review is also the newest version of its own ${kind}`
    + (made.title ? `, “${made.title}”${reviews}.` : `${reviews}.`);
}

/** The notice after a change of where its reports go. */
export function reportNotice(state, pipName = 'It') {
  return state.report_as === 'chat' ? `${pipName}’s reports come in its chat only.`
    : `Each review from ${pipName} is also kept as its own ${state.report_as === 'doc' ? 'document' : 'spreadsheet'}.`;
}

/** The pieces both layouts show. */
function parts(state, {esc, busy, pipName, dashboards, dashboardsError}) {
  const off = busy ? ' disabled' : '';
  const made = madeReport(state);
  const kind = state.report_as === 'doc' ? 'document' : 'spreadsheet';
  const report = `<select id="pipReportAs" aria-label="Where ${esc(pipName)}’s reports go" aria-describedby="pipReportSays"${off}>`
    + REPORT_AS.map(v => `<option value="${v}"${state.report_as === v ? ' selected' : ''}>${REPORT_NAMES[v]}</option>`).join('') + '</select>'
    + (made ? `<button type="button" class="quiet pill" data-artifact-open="${esc(made.id)}" data-artifact-type="${state.report_as}" aria-label="Open ${made.title ? `“${esc(made.title)}”, ` : ''}${esc(pipName)}’s ${kind}${made.version ? `, version ${made.version}` : ''}">Open</button>` : '');
  const known = new Map((dashboards || []).map(d => [d.id, d]));
  const rows = state.dashboards.map(id => {
    const d = known.get(id), gone = !!dashboards && !d;
    const name = d?.title || (gone ? 'A dashboard that was removed' : 'Dashboard');
    return `<li class="pip-dashboard" data-dashboard="${esc(id)}"><span class="row-words"><span class="pip-dashboard-name">${esc(name)}</span>`
      + `<small>${gone ? 'It’s in DGC’s trash, or gone. Remove it here.' : d ? `Dashboard · version ${d.version}` : 'Dashboard'}</small></span>`
      + '<span class="pip-artifacts-actions">'
      + (gone ? '' : `<button type="button" class="quiet" data-artifact-open="${esc(id)}" data-artifact-type="dashboard" aria-label="Open ${esc(name)}">Open</button>`)
      + `<button type="button" class="quiet" data-dashboard-remove="${esc(id)}" aria-label="Stop refreshing ${esc(name)}"${off}>Remove</button></span></li>`;
  });
  const addable = (dashboards || []).filter(d => !state.dashboards.includes(d.id));
  let add = '', note = '';
  if (dashboardsError) note = dashboardsError;
  else if (!dashboards) note = 'Loading your dashboards…';
  else if (state.dashboards.length >= MAX_DASHBOARDS) note = `That’s the most a Pip refreshes: ${MAX_DASHBOARDS}. Remove one to add another.`;
  else if (!dashboards.length) note = 'You have no dashboards yet. Ask for one in a chat: choose Artifact, then Dashboard.';
  else if (!addable.length) note = 'It refreshes every dashboard you have.';
  else {
    add = `<select id="pipDashboardAdd" aria-label="Add a dashboard for ${esc(pipName)} to refresh"${off}><option value="" selected>Add a dashboard…</option>`
      + addable.map(d => `<option value="${esc(d.id)}">${esc(d.title)}</option>`).join('') + '</select>';
  }
  const says = `${esc(pipName)} refreshes ${rows.length ? 'these' : 'the dashboards you add here'} after every run it finishes, so they stay current.`;
  return {report, rows, add, note, says, loading: !dashboards && !dashboardsError};
}

/** A Personal Pip's page: its dashboards, as a group of rows ("Seeing", "How much it asks"). */
export function artifactsPageMarkup(state, {esc, busy = false, error = '', pipName = 'It', reviews = false, dashboards = null, dashboardsError = ''}) {
  const label = reviews ? 'Reports and dashboards' : 'Dashboards';
  if (!state) return `<section class="pip-page-group pip-artifacts" aria-label="${label}">${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}</section>`;
  const p = parts(state, {esc, busy, pipName, dashboards, dashboardsError});
  return `<section class="pip-page-group pip-artifacts" aria-label="${label}">`
    + (reviews ? `<div class="pip-page-row static"><span class="row-words"><strong>Reports</strong><small id="pipReportSays">${esc(reportSays(state))}</small></span><span class="pip-artifacts-actions">${p.report}</span></div>` : '')
    + `<h3 class="pip-page-label" id="pipDashboardsLabel">Dashboards it refreshes</h3><p class="muted pip-artifacts-says">${p.says}</p>`
    + (p.rows.length ? `<ul class="pip-page-list pip-dashboards" aria-labelledby="pipDashboardsLabel" data-dashboards>${p.rows.join('')}</ul>` : '')
    + (p.add ? `<div class="pip-page-row static pip-dashboard-add">${p.add}</div>` : '')
    + (p.note ? `<p class="muted pip-artifacts-says"${p.loading ? ' role="status"' : ''}>${esc(p.note)}</p>` : '')
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

/** A reviewing Pip's Settings tab (and any Pip whose settings are sections): Reports, then the dashboards it refreshes. */
export function artifactsSectionsMarkup(state, {esc, busy = false, error = '', pipName = 'It', reviews = false, dashboards = null, dashboardsError = ''}) {
  if (!state) return `<section class="section pip-artifacts-section" aria-label="${reviews ? 'Reports and dashboards' : 'Dashboards'}"><h2>${reviews ? 'Reports' : 'Dashboards it refreshes'}</h2>`
    + (error ? `<p class="notice error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>') + '</section>';
  const p = parts(state, {esc, busy, pipName, dashboards, dashboardsError});
  const failed = error ? `<p class="notice error" role="alert">${esc(error)}</p>` : '';
  return (reviews ? `<section class="section pip-artifacts-section" aria-labelledby="pipReportsTitle"><h2 id="pipReportsTitle">Reports</h2>`
      + `<p class="muted" id="pipReportSays">${esc(reportSays(state))}</p><div class="actions pip-artifacts-actions">${p.report}</div></section>` : '')
    + `<section class="section pip-artifacts-section" aria-labelledby="pipDashboardsLabel"><h2 id="pipDashboardsLabel">Dashboards it refreshes</h2><p class="muted">${p.says}</p>`
    + (p.rows.length ? `<ul class="pip-dashboards" aria-labelledby="pipDashboardsLabel" data-dashboards>${p.rows.join('')}</ul>` : '')
    + (p.add ? `<div class="actions pip-dashboard-add">${p.add}</div>` : '')
    + (p.note ? `<p class="muted"${p.loading ? ' role="status"' : ''}>${esc(p.note)}</p>` : '')
    + failed + '</section>';
}
