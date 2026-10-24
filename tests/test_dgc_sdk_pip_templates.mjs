/** Pips API 64 in the TypeScript SDK: Pip templates in code. definePipTemplate (checked before anything is sent),
 *  pips.ensure, pips.ensureAll (every template checked first, then each ensured, then prune), pips.templates and
 *  pips.decideTemplateChange, all refused before API 64. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError, definePipTemplate, pipTemplateWire } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const WEEKDAYS = { kind: 'schedule', schedule: { type: 'cron', cron: '30 9 * * 1-5', timezone: 'Asia/Kolkata' } };
const DUNNING = definePipTemplate({ key: 'dunning', name: 'Dunning', instructions: 'Chase unpaid orders politely.',
  tools: ['app:shop/find_unpaid_orders'], routines: [{ title: 'Unpaid orders', prompt: 'List orders unpaid after 7 days.', when: WEEKDAYS }] });
const DISPATCH = definePipTemplate({ key: 'dispatch', name: 'Dispatch', instructions: 'Get paid orders dispatched.',
  tools: ['app:shop/get_order', 'app:shop/create_dispatch'], alwaysAllow: ['app:shop/create_dispatch'],
  routines: [{ title: 'New orders', prompt: 'Check the order; propose a dispatch.', when: { app: 'shop', event: 'order.created' } }] });
const CHANGE = 'tmplchange_' + 'a'.repeat(32);
const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
function fixture(version, extra = {}, answer = (r) => ({ request: r })) {
  const calls = [];
  const wire = { request: async (payload, response, opts) => {
    calls.push(payload);
    return { type: 'pips_result', request_id: opts.requestId, command: payload.request.type, ok: true, result: answer(payload.request) };
  } };
  return { calls, session: new Session(wire, { capabilities: { pips_supported: true, pips_enabled: true, pips_api_version: version } }, { ...init, ...extra }) };
}

test('a template is checked and normalized where it is made, and frozen', () => {
  assert.deepEqual([...COMMAND_FIELDS.ensure_pip_template], ['template', 'accept_widening', 'overwrite_user_changes']);
  assert.deepEqual([...COMMAND_FIELDS.prune_pip_templates], ['keep']);
  assert.deepEqual([...COMMAND_FIELDS.list_pip_templates], ['pip_id']);
  assert.deepEqual([...COMMAND_FIELDS.decide_pip_template_change], ['change_id', 'decision', 'expected_digest']);
  assert.deepEqual(DISPATCH.routines[0].when, { kind: 'app', app: 'shop', event: 'order.created' }, 'the short form of an app event');
  assert.equal(DUNNING.level, 'ask');
  assert.equal(DUNNING.model, null);
  assert.throws(() => { DUNNING.tools.push('computer'); }, TypeError);
  const wire = pipTemplateWire(DISPATCH);
  assert.deepEqual(wire.always_allow, ['app:shop/create_dispatch']);
  assert.equal(Object.hasOwn(wire, 'model'), false, 'no model: DGC\'s own default');
  const base = { key: 'dunning', name: 'Dunning', instructions: 'Chase.' };
  const bad = [{ key: 'Dunning' }, { key: 'x'.repeat(41) }, { name: '' }, { name: 'two\nlines' }, { instructions: ' ' },
    { level: 'always' }, { tools: ['gmail'] }, { tools: 'app:shop/x' }, { tools: ['app:shop/x', 'app:shop/x'] },
    { alwaysAllow: ['app:shop/x'] }, { model: 'has space' }, { routines: [{ title: 'A', prompt: 'x' }] },
    { routines: [{ title: 'A', prompt: 'x', when: { kind: 'email', query: 'from:x' } }] },
    { routines: [{ title: 'A', prompt: 'x', when: WEEKDAYS }, { title: 'A', prompt: 'y', when: WEEKDAYS }] },
    { routines: Array.from({ length: 11 }, (_, n) => ({ title: `R${n}`, prompt: 'x', when: WEEKDAYS })) },
    { always_allow: [] }];
  for (const changes of bad) assert.throws(() => definePipTemplate({ ...base, ...changes }), DGCConfigError, JSON.stringify(changes).slice(0, 80));
  assert.throws(() => definePipTemplate({ ...base, always_allow: [] }), /it is alwaysAllow/);
});

test('ensure, templates and decideTemplateChange: refused before API 64, checked, then sent', async () => {
  const old = fixture(63);
  await assert.rejects(old.session.pips.ensure(DUNNING, { approved: true }), (e) => e instanceof DGCUnsupportedError && /API 64/.test(e.message));
  await assert.rejects(old.session.pips.templates(), /API 64/);
  await assert.rejects(old.session.pips.ensureAll([DUNNING], { approved: true, prune: true }), /API 64/);
  await assert.rejects(old.session.pips.decideTemplateChange(CHANGE, 'accept', '0'.repeat(64), { approved: true }), /API 64/);
  assert.equal(old.calls.length, 0);
  const current = fixture(64);
  await assert.rejects(current.session.pips.ensure(DUNNING), /approved/);
  await assert.rejects(current.session.pips.ensure({ key: 'dunning' }, { approved: true }), DGCConfigError);
  await assert.rejects(current.session.pips.ensureAll([DUNNING, DUNNING], { approved: true }), /share the key dunning/);
  await assert.rejects(current.session.pips.ensureAll([DUNNING, { key: 'bad key', name: 'x', instructions: 'y' }], { approved: true }), DGCConfigError);
  await assert.rejects(current.session.pips.ensureAll([DUNNING], { approved: true, prune: 'yes' }), DGCConfigError);
  await assert.rejects(current.session.pips.decideTemplateChange('tmplchange_x', 'accept', '0'.repeat(64), { approved: true }), DGCConfigError);
  await assert.rejects(current.session.pips.decideTemplateChange(CHANGE, 'maybe', '0'.repeat(64), { approved: true }), DGCConfigError);
  await assert.rejects(current.session.pips.templates('not-a-pip'), DGCConfigError);
  await assert.rejects(current.session.pips.mutate('prune_pip_templates', { keep: ['Bad Key'] }, { approved: true }), DGCConfigError);
  assert.equal(current.calls.length, 0, 'nothing left the process');
  const sent = (await current.session.pips.ensure(DISPATCH, { approved: true, acceptWidening: true })).request;
  assert.deepEqual({ type: sent.type, accept_widening: sent.accept_widening, overwrite_user_changes: sent.overwrite_user_changes },
    { type: 'ensure_pip_template', accept_widening: true, overwrite_user_changes: false });
  assert.deepEqual(sent.template, pipTemplateWire(DISPATCH));
  const plain = (await current.session.pips.mutate('ensure_pip_template', { template: pipTemplateWire(DUNNING) }, { approved: true })).request;
  assert.deepEqual(plain.template, pipTemplateWire(DUNNING), 'the wire shape is read the same way');
  assert.equal((await current.session.pips.templates('pip_' + 'b'.repeat(32))).request.pip_id, 'pip_' + 'b'.repeat(32));
  assert.equal((await current.session.pips.decideTemplateChange(CHANGE, 'reject', 'c'.repeat(64), { approved: true })).request.decision, 'reject');
});

test('ensureAll ensures each, then prunes with their keys', async () => {
  const answers = { dunning: { unchanged: true, waiting: [] }, dispatch: { unchanged: false, waiting: [CHANGE] } };
  const run = fixture(64, {}, (r) => r.type === 'ensure_pip_template' ? { ...answers[r.template.key], key: r.template.key }
    : { pruned: [{ key: 'old', keep: r.keep }], already: [], kept: 2 });
  const done = await run.session.pips.ensureAll([DUNNING, DISPATCH], { approved: true, prune: true });
  assert.deepEqual(run.calls.map((c) => c.request.type), ['ensure_pip_template', 'ensure_pip_template', 'prune_pip_templates']);
  assert.deepEqual(done.pruned, [{ key: 'old', keep: ['dunning', 'dispatch'] }]);
  assert.deepEqual([done.waiting, done.unchanged], [[CHANGE], false]);
  run.calls.length = 0;
  assert.equal((await run.session.pips.ensureAll([DUNNING], { approved: true })).unchanged, true);
  assert.deepEqual(run.calls.map((c) => c.request.type), ['ensure_pip_template'], 'no prune unless asked');
});

test('plan mode refuses ensure', async () => {
  const planning = fixture(64, { permissionMode: 'plan' });
  await assert.rejects(planning.session.pips.ensure(DUNNING, { approved: true }), /plan mode/);
  assert.equal(planning.calls.length, 0);
});
