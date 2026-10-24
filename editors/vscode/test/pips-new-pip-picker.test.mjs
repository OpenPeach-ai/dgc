// New Pip picks a character with a big face and a dropdown beside it (the founder, 24 Oct: "Agree with your suggestion,
// do it"), not a grid of seven tiles. For a Project Pip the character is the job, so its list says what each does ("Review
// the code for bugs", Rook beside it); for a Personal Pip it is only a face and a name, so its list is the names. Each row
// has its small face and the big face follows the choice. The dropdown is a listbox a keyboard and a screen reader can
// use, a kind that can't be made yet stays in it greyed with its reason, and what gets created is what the grid created.
// Mounted as the side bar mounts it, in a shadow root.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const client = (await build({ entryPoints: [src + 'pipsClient.js'], bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } })).outputFiles[0].text;
const windows = []; after(() => windows.forEach((w) => w.close()));
const hex = (c) => c.repeat(32);
const PW = 'ws_' + hex('e'), W = 'ws_' + hex('d'), NEW = 'pip_' + hex('7');
const KINDS = ['scout', 'lens', 'patch', 'rook', 'pulse', 'lock', 'quill'];
const ROLES = { core: 'Main chat', scout: 'Repository exploration', lens: 'Repository research', patch: 'File fixes', rook: 'Code review', pulse: 'Test execution', lock: 'Security review', quill: 'Documentation drafts' };
const DEFAULT_NAMES = { scout: 'Repository scout', lens: 'Repository researcher', patch: 'File fixer', rook: 'Code reviewer', pulse: 'Test runner', lock: 'Security reviewer', quill: 'Documentation writer' };
const catalog = (unavailable = {}) => ['core', ...KINDS].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1), role: ROLES[id],
  description: `${id} reads and reports`, available: id !== 'core' && !(id in unavailable), unavailable_reason: id === 'core' ? 'Core is the main chat.' : unavailable[id] || null,
  default_name: DEFAULT_NAMES[id] || 'Core', default_goal: `The ${id} job.`, engine: id === 'core' ? null : id === 'patch' ? 'patch' : id === 'pulse' ? 'test' : id === 'quill' ? 'documentation_draft' : 'source_audit' }));
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }

function setup({ types = catalog() } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="pips-host"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window; windows.push(w);
  const sent = [], answered = new Set(), listeners = new Set();
  w.HTMLCanvasElement.prototype.getContext = () => null; w.TextEncoder = TextEncoder; w.CSS = { escape: (s) => s };
  w.eval(client);
  const shadow = w.document.getElementById('pips-host').attachShadow({ mode: 'open' });
  w.DgcPips.mount({ root: shadow, postMessage: (m) => sent.push(m), onMessage: (l) => { listeners.add(l); return () => listeners.delete(l); }, getState: () => undefined, setState() {} });
  const message = (data) => listeners.forEach((l) => l(data));
  const runner = { runner_id: 'runner', status: 'running', online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } };
  const pip = (id, ws, type, name) => ({ id, workspace_id: ws, pip_type: type, name, goal: '', source_ref: 'HEAD', source_policy: { mode: ws === PW ? 'personal' : 'committed_only' }, status: 'active', current_version: 1, lifecycle_revision: 0, policy: 'read_only', trigger: 'manual', schedule: null, proposals: [], pending_review_count: 0 });
  const pips = { [PW]: [pip('pip_' + hex('c'), PW, 'core', 'Core')], [W]: [pip('pip_' + hex('a'), W, 'rook', 'Billing audit')] };
  const reply = (r) => ({ list_workspaces: () => ({ workspaces: [{ id: PW, name: 'Personal', kind: 'personal' }, { id: W, name: 'shop', kind: 'git' }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), get_pip_runner: () => ({ runner }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => { const list = pips[r.workspace_id] || []; return { pips: list, total: list.length, next_offset: null }; },
    get_workspace_context: () => ({ context: { workspace_id: r.workspace_id, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: 'm', models: [{ id: 'm', name: 'm' }], connection: 'configured' }),
    list_pip_attention: () => ({ as_of: new Date().toISOString(), total: 0, counts: {}, by_pip: {}, items: [], truncated: false }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000, count: 1 }),
    get_pip_digest: () => undefined }[r.type]?.());
  async function drain() { for (let n = 0; n < 25; n++) { await flush(); for (const m of sent.filter((m) => m.type === 'pipsRequest' && !answered.has(m.id))) { const result = reply(m.request); if (result === undefined) continue; answered.add(m.id); message({ type: 'pipsReply', id: m.id, ok: true, result }); } } await flush(); }
  message({ type: 'pipsConnection', apiVersion: 65, generation: 1, connected: true, supported: true, enabled: true, folder: true });
  const $ = (s) => shadow.querySelector(s), $$ = (s) => [...shadow.querySelectorAll(s)];
  const click = async (s) => { const el = typeof s === 'string' ? $(s) : s; assert.ok(el, 'Missing ' + s); el.click(); await flush(); };
  const key = (k, target = shadow.activeElement) => { assert.ok(target, `no focus for ${k}`); const e = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true }); target.dispatchEvent(e); return e; };
  const type = async (s, value) => { const el = $(s); el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); await flush(); };
  async function tab(scope) { if (!$(`[data-pips-tab="${scope}"]`)) $('#simple-back')?.click(); await drain(); $(`[data-pips-tab="${scope}"]`)?.click(); await drain(); }
  const requests = (t) => sent.filter((m) => m.type === 'pipsRequest' && m.request.type === t).map((m) => JSON.parse(JSON.stringify(m.request)));
  return { w, shadow, $, $$, click, key, type, tab, drain, requests, focus: () => shadow.activeElement };
}
// What the dropdown says and does, read from the page.
const state = (x, id) => {
  const button = x.$(`#${id}`), list = x.$(`#${id}-list`);
  return { expanded: button.getAttribute('aria-expanded'), open: !list.hidden, active: list.getAttribute('aria-activedescendant') || '', value: button.textContent.trim(),
    chosen: list.querySelector('[aria-selected=true]')?.dataset.pick || '', face: x.$(`[data-picker="${id}"] .pip-picker-face .avatar`)?.dataset.character || '' };
};
async function projectDialog(options) { const x = setup(options); await x.drain(); await x.tab('project'); await x.click('#simple-new'); await x.drain(); return x; }
async function personalDialog(options) { const x = setup(options); await x.drain(); await x.tab('personal'); await x.click('#simple-new'); await x.drain(); return x; }

test('New Pip shows a big face and a dropdown beside it, not a grid of tiles, for a Project Pip and a Personal Pip', async () => {
  for (const [x, id, label, lead, first] of [[await projectDialog(), 'new-pip-kind', 'What should it do?', 'Pick what it should do, then name it.', 'scout'],
    [await personalDialog(), 'new-pip-character', 'Character', 'Pick a character and give it a name.', 'scout']]) {
    const dialog = x.$('.dialog');
    assert.equal(dialog.querySelector('.character-grid, [data-new-character], [role=radiogroup]'), null, `${id}: no grid of tiles`);
    assert.equal(dialog.querySelector('#review-title + p').textContent, lead);
    const picker = dialog.querySelector('.pip-picker'), face = picker.querySelector('.pip-picker-face .avatar'), button = picker.querySelector('button.pip-picker-button');
    assert.equal(face.dataset.character, first, 'the big face is the chosen character');
    assert.equal(x.$(`#${id}-label`).textContent, label);
    // The WAI-ARIA collapsible listbox: a button that says it opens a listbox, and the listbox it controls.
    assert.equal(button.id, id);
    assert.equal(button.getAttribute('aria-haspopup'), 'listbox');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.getAttribute('aria-controls'), `${id}-list`);
    assert.equal(button.getAttribute('aria-labelledby'), `${id}-label ${id}-value`, 'it reads as its label and its value');
    const list = x.$(`#${id}-list`);
    assert.equal(list.getAttribute('role'), 'listbox'); assert.equal(list.hidden, true); assert.equal(list.getAttribute('aria-labelledby'), `${id}-label`);
    assert.equal(list.getAttribute('tabindex'), '-1');
    const options = [...list.children];
    assert.equal(options.length, 7, 'every character but Core');
    assert.ok(options.every((o) => o.getAttribute('role') === 'option'));
    assert.deepEqual(options.filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.dataset.pick), [first], 'one chosen');
    assert.deepEqual(options.map((o) => o.querySelector('.avatar')?.dataset.character), KINDS, 'each row has its small face');
    assert.ok(options.every((o) => !o.matches('button, [tabindex]')), 'the rows themselves are not tab stops: the list has the focus');
  }
});

test('the Project list says what each does, with its name beside it; the Personal list is the names', async () => {
  const project = await projectDialog();
  const rows = project.$$('#new-pip-kind-list [role=option]');
  assert.deepEqual(rows.map((o) => [o.querySelector('.pip-picker-main').textContent, o.querySelector('.pip-picker-aside').textContent]), [
    ['Map out the project', 'Scout'], ['Answer a question about the code', 'Lens'], ['Fix files you approve', 'Patch'], ['Review the code for bugs', 'Rook'],
    ['Run tests you approve', 'Pulse'], ['Look for security problems', 'Lock'], ['Draft documentation', 'Quill']]);
  assert.equal(rows[3].getAttribute('aria-label'), 'Review the code for bugs, Rook', 'a screen reader hears the job, then the name');
  assert.equal(project.$('#new-pip-kind-value').textContent, 'Map out the project', 'the button says the job');
  const personal = await personalDialog();
  const names = personal.$$('#new-pip-character-list [role=option]');
  assert.deepEqual(names.map((o) => o.textContent), ['Scout', 'Lens', 'Patch', 'Rook', 'Pulse', 'Lock', 'Quill'], 'only the names: no job words');
  assert.equal(personal.$$('#new-pip-character-list .pip-picker-aside').length, 0);
  assert.equal(personal.$('#new-pip-character-value').textContent, 'Scout');
});

test('choosing changes the big face at once, and for a Project Pip what it says about the job', async () => {
  const x = await projectDialog();
  assert.match(x.$('.new-pip-kind .type-role').textContent, /^Scout · Repository exploration · Reads only/);
  await x.click('#new-pip-kind');
  assert.equal(state(x, 'new-pip-kind').expanded, 'true');
  await x.click('#new-pip-kind-list [data-pick="lock"]');
  assert.deepEqual(state(x, 'new-pip-kind'), { expanded: 'false', open: false, active: '', value: 'Look for security problems', chosen: 'lock', face: 'lock' });
  assert.match(x.$('.new-pip-kind .type-role').textContent, /^Lock · Security review · Reads only/, 'the description follows');
  assert.equal(x.$('.new-pip-kind .muted').textContent, 'lock reads and reports');
  assert.equal(x.$('#name').value, 'Security reviewer', 'its name starts as the kind’s own, as before');
  assert.equal(x.focus()?.id, 'new-pip-kind', 'the focus is back on the dropdown');
  await x.click('#new-pip-kind'); await x.click('#new-pip-kind-list [data-pick="patch"]');
  assert.equal(state(x, 'new-pip-kind').face, 'patch');
  assert.equal(x.$('#review-confirm').textContent, 'Review what it can do…', 'Patch still shows what it can do first');
  const y = await personalDialog();
  await y.type('#newPipName', 'Gmail');
  await y.click('#new-pip-character'); await y.click('#new-pip-character-list [data-pick="quill"]');
  assert.deepEqual(state(y, 'new-pip-character'), { expanded: 'false', open: false, active: '', value: 'Quill', chosen: 'quill', face: 'quill' });
  assert.equal(y.$('#newPipName').value, 'Gmail', 'a name typed first stays');
});

test('the keys: arrows, Home and End move, typing goes to a row, Enter or Space picks, Esc and Tab close it', async () => {
  const x = await projectDialog(), at = () => state(x, 'new-pip-kind');
  x.$('#new-pip-kind').focus();
  assert.ok(x.key('ArrowDown').defaultPrevented);
  assert.deepEqual([at().expanded, at().open, at().active], ['true', true, 'new-pip-kind-scout'], 'the Down arrow opens it on the chosen row');
  assert.equal(x.focus()?.id, 'new-pip-kind-list', 'the list has the focus');
  x.key('ArrowDown'); assert.equal(at().active, 'new-pip-kind-lens');
  x.key('ArrowUp'); x.key('ArrowUp'); assert.equal(at().active, 'new-pip-kind-scout', 'the Up arrow stops at the first');
  x.key('End'); assert.equal(at().active, 'new-pip-kind-quill');
  x.key('ArrowDown'); assert.equal(at().active, 'new-pip-kind-quill', 'the Down arrow stops at the last');
  x.key('Home'); assert.equal(at().active, 'new-pip-kind-scout');
  x.key('r'); assert.equal(at().active, 'new-pip-kind-rook', 'r: Review the code for bugs');
  x.key('r'); assert.equal(at().active, 'new-pip-kind-pulse', 'r again: Run tests you approve');
  assert.equal(at().chosen, 'scout', 'moving picks nothing');
  x.key('Enter'); await x.drain();
  assert.deepEqual([at().open, at().chosen, at().face], [false, 'pulse', 'pulse'], 'Enter picks');
  assert.equal(x.focus()?.id, 'new-pip-kind', 'and gives the button the focus back');
  x.key('ArrowUp'); assert.equal(at().active, 'new-pip-kind-pulse', 'the Up arrow opens it on the chosen row');
  x.key('l'); x.key('o'); assert.equal(at().active, 'new-pip-kind-lock', 'lo: Look for security problems');
  x.key(' '); await x.drain();
  assert.deepEqual([at().open, at().chosen, at().face], [false, 'lock', 'lock'], 'Space picks');
  x.key('ArrowDown'); x.key('ArrowDown');
  assert.ok(x.key('Escape').defaultPrevented);
  assert.deepEqual([at().expanded, at().open, at().chosen], ['false', false, 'lock'], 'Esc closes it and picks nothing');
  assert.ok(x.$('.dialog'), 'only the list: the dialog stays open');
  assert.equal(x.focus()?.id, 'new-pip-kind', 'the button has the focus back');
  x.key('ArrowDown');
  assert.equal(x.key('Tab').defaultPrevented, false, 'Tab goes on as Tab does');
  assert.deepEqual([at().open, at().chosen], [false, 'lock'], 'Tab closes it');
  assert.equal(x.focus()?.id, 'new-pip-kind', 'from the button, so the focus moves to what comes after it');
  x.key('Escape');
  assert.equal(x.$('.dialog'), null, 'with the list shut, Esc closes the dialog as before');
});

test('a click outside the list, or the focus moving on, closes it; a click on the button opens and closes it', async () => {
  const x = await projectDialog();
  await x.click('#new-pip-kind'); assert.equal(state(x, 'new-pip-kind').open, true);
  await x.click('#new-pip-kind'); assert.equal(state(x, 'new-pip-kind').open, false, 'the button closes it again');
  await x.click('#new-pip-kind'); await x.click('.dialog .new-pip-kind');
  assert.equal(state(x, 'new-pip-kind').open, false, 'a click outside closes it');
  assert.ok(x.$('.dialog'));
  await x.click('#new-pip-kind'); x.$('#name').focus();
  assert.equal(state(x, 'new-pip-kind').open, false, 'the focus moving on closes it');
  assert.equal(x.focus()?.id, 'name', 'and stays where it went');
  await x.click('#new-pip-kind'); await x.click('#review-cancel');
  assert.equal(x.$('.dialog'), null, 'a click on another control closes the list and does what that control does');
});

test('a kind that can’t be made yet stays in the list, greyed, with its reason; it can’t be picked', async () => {
  const x = await projectDialog({ types: catalog({ pulse: 'Update DGC to run tests from a Pip.' }) });
  const pulse = x.$('#new-pip-kind-list [data-pick="pulse"]');
  assert.equal(pulse.getAttribute('aria-disabled'), 'true');
  assert.equal(pulse.getAttribute('title'), 'Update DGC to run tests from a Pip.');
  assert.equal(pulse.querySelector('.pip-picker-reason').textContent, 'Update DGC to run tests from a Pip.', 'the reason shows in the row');
  assert.equal(pulse.getAttribute('aria-label'), 'Run tests you approve, Pulse. Update DGC to run tests from a Pip.');
  assert.equal(pulse.querySelector('.avatar').dataset.pose, 'offline');
  const at = () => state(x, 'new-pip-kind');
  await x.click('#new-pip-kind'); await x.click(pulse);
  assert.deepEqual([at().open, at().chosen], [true, 'scout'], 'a click on it picks nothing');
  x.key('End'); x.key('ArrowUp'); x.key('ArrowUp');
  assert.equal(at().active, 'new-pip-kind-rook', 'the arrows step over it');
  x.key('r'); assert.equal(at().active, 'new-pip-kind-rook', 'typing finds only what can be picked');
  const lastOnly = await projectDialog({ types: catalog({ quill: 'Not yet.' }) });
  lastOnly.$('#new-pip-kind').focus(); lastOnly.key('ArrowDown'); lastOnly.key('End');
  assert.equal(state(lastOnly, 'new-pip-kind').active, 'new-pip-kind-lock', 'End is the last one that can be picked');
});

test('what gets created is what the grid created, for every kind: the same create_pip', async () => {
  // A Project Pip: its kind, its kind's own name and job, HEAD and the default model, as the grid sent them; Patch and
  // Pulse first say what they can do. The words a kind picks up are kept per kind, as the grid kept them.
  for (const kind of KINDS) {
    const x = await projectDialog();
    await x.click('#new-pip-kind'); await x.click(`#new-pip-kind-list [data-pick="${kind}"]`);
    await x.click('#review-confirm'); await x.drain();
    if (kind === 'patch' || kind === 'pulse') {
      assert.equal(x.$('.dialog h2').textContent, `Create ${kind[0].toUpperCase() + kind.slice(1)}?`, `${kind}: what it can do, first`);
      assert.ok(x.$('#new-pip-back'));
      assert.equal(x.requests('create_pip').length, 0);
      await x.click('#review-confirm'); await x.drain();
    }
    assert.deepEqual(x.requests('create_pip'), [{ type: 'create_pip', workspace_id: W, pip_type: kind, model_choice: { mode: 'default' }, name: DEFAULT_NAMES[kind], goal: `The ${kind} job.`, source_ref: 'HEAD' }], kind);
  }
  // Picked by keys, after looking at another kind: the one picked.
  const k = await projectDialog();
  k.$('#new-pip-kind').focus(); k.key('ArrowDown'); k.key('l'); k.key('o'); k.key('Enter'); await k.drain();
  await k.click('#review-confirm'); await k.drain();
  assert.equal(k.requests('create_pip')[0]?.pip_type, 'lock');
  // A Personal Pip: its character and the name you gave it, nothing else.
  for (const kind of KINDS) {
    const x = await personalDialog();
    await x.click('#new-pip-character'); await x.click(`#new-pip-character-list [data-pick="${kind}"]`);
    await x.type('#newPipName', ' Gmail ');
    await x.click('#review-confirm'); await x.drain();
    assert.deepEqual(x.requests('create_pip'), [{ type: 'create_pip', workspace_id: PW, pip_type: kind, name: 'Gmail', goal: '', source_ref: 'HEAD', model_choice: { mode: 'default' } }], `Personal ${kind}`);
  }
});

test('the picker on its own: a redraw while its list is open opens it again on the same row', async () => {
  const pickerModule = (await build({ entryPoints: [src + 'pipPicker.js'], bundle: true, write: false, format: 'iife', globalName: 'Picker', footer: { js: 'globalThis.Picker = Picker;' } })).outputFiles[0].text;
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window; windows.push(w);
  w.eval(pickerModule);
  const { pickerMarkup, createPicker } = w.Picker, picks = [];
  const draw = (value) => { w.document.getElementById('host').innerHTML = pickerMarkup({ id: 'p', label: 'Pick', value, face: '<i></i>', options: [{ value: 'a', label: 'Apple' }, { value: 'b', label: 'Banana', aside: 'B' }, { value: 'c', label: 'Cherry' }] }); };
  draw('a');
  const picker = createPicker({ root: w.document, onPick: (id, value) => picks.push([id, value]) });
  for (const t of ['click', 'keydown', 'focusout']) w.document.addEventListener(t, (e) => picker[t](e));
  const key = (k) => w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  w.document.getElementById('p').click(); key('ArrowDown');
  assert.equal(w.document.getElementById('p-list').getAttribute('aria-activedescendant'), 'p-b');
  draw('a'); picker.restore();
  const list = w.document.getElementById('p-list');
  assert.equal(list.hidden, false, 'open again');
  assert.equal(list.getAttribute('aria-activedescendant'), 'p-b', 'on the same row');
  assert.equal(w.document.activeElement, list, 'with the focus');
  key('Enter');
  assert.deepEqual(picks, [['p', 'b']]);
  assert.equal(picker.isOpen(), '');
  draw('b'); picker.restore();
  assert.equal(w.document.getElementById('p-list').hidden, true, 'a closed list stays closed');
  assert.equal(w.document.getElementById('p-value').textContent, 'Banana');
});
