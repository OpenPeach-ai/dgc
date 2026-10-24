/** Pips API 63 in the TypeScript SDK: events from your app. pips.trigger (trigger_app_event: no approved, its payload
 *  outside the 32 KiB budget and bounded to 32 KB of JSON, refused before API 63 and checked before anything is sent),
 *  pips.events (list_app_events) and list_pip_routines' app_events. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const ORDER = { order_id: 'ORD-1041', total: 1200 };
const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
function fixture(version, extra = {}) {
  const calls = [];
  const wire = { request: async (payload, response, opts) => {
    calls.push(payload);
    return { type: 'pips_result', request_id: opts.requestId, command: payload.request.type, ok: true, result: { request: payload.request } };
  } };
  return { calls, session: new Session(wire, { capabilities: { pips_supported: true, pips_enabled: true, pips_api_version: version } }, { ...init, ...extra }) };
}

test('trigger and events: known, refused before API 63, checked, then sent with no approval', async () => {
  assert.deepEqual([...COMMAND_FIELDS.trigger_app_event], ['app', 'event', 'payload', 'idempotency_key']);
  assert.deepEqual([...COMMAND_FIELDS.list_app_events], ['app', 'limit']);
  assert.deepEqual([...COMMAND_FIELDS.list_pip_routines], ['pip_id', 'app_events']);
  const old = fixture(62);
  await assert.rejects(old.session.pips.trigger('shop', 'order.created', ORDER, { idempotencyKey: 'ORD-1041' }),
    (e) => e instanceof DGCUnsupportedError && /API 63/.test(e.message));
  await assert.rejects(old.session.pips.events('shop'), /API 63/);
  await assert.rejects(old.session.pips.read('list_pip_routines', { pip_id: 'pip_x', app_events: true }), /API 63/);
  assert.equal(old.calls.length, 0);
  const current = fixture(63);
  const bad = [[['Shop', 'order.created', ORDER], 'ORD-1'], [['shop', 'Order Created', ORDER], 'ORD-1'],
    [['shop', 'order.created', ORDER], ''], [['shop', 'order.created', ORDER], 'a\nb'], [['shop', 'order.created', ORDER], 'x'.repeat(201)],
    [['shop', 'order.created', { blob: 'x'.repeat(33000) }], 'ORD-1'], [['shop', 'order.created', { n: Infinity }], 'ORD-1'],
    [['shop', 'order.created', { when: new Date() }], 'ORD-1'], [['shop', 'order.created', { big: 2 ** 60 }], 'ORD-1']];
  for (const [args, key] of bad) {
    await assert.rejects(current.session.pips.trigger(...args, { idempotencyKey: key }), DGCConfigError, `${JSON.stringify(args).slice(0, 60)} ${key.slice(0, 10)}`);
  }
  await assert.rejects(current.session.pips.trigger('shop', 'order.created', { blob: 'x'.repeat(33000) }, { idempotencyKey: 'k' }), /this one is 33 KB/);
  await assert.rejects(current.session.pips.trigger('shop', 'order.created', ORDER, {}), /idempotency_key/);
  await assert.rejects(current.session.pips.events('shop', { limit: 0 }), DGCConfigError);
  await assert.rejects(current.session.pips.read('list_pip_routines', { pip_id: 'pip_x', app_events: 'yes' }), DGCConfigError);
  assert.equal(current.calls.length, 0, 'nothing left the process');
  const sent = (await current.session.pips.trigger('shop', 'order.created', ORDER, { idempotencyKey: 'ORD-1041' })).request;
  assert.deepEqual({ type: sent.type, app: sent.app, event: sent.event, payload: sent.payload, idempotency_key: sent.idempotency_key },
    { type: 'trigger_app_event', app: 'shop', event: 'order.created', payload: ORDER, idempotency_key: 'ORD-1041' });
  const bare = (await current.session.pips.trigger('shop', 'order.paid', undefined, { idempotencyKey: 'k2' })).request;
  assert.equal(Object.hasOwn(bare, 'payload'), false, 'no payload: none sent');
  const big = { lines: Array.from({ length: 30 }, () => 'x'.repeat(1000)) };     // 30 KB: outside the 32 KiB budget
  assert.deepEqual((await current.session.pips.trigger('shop', 'order.created', big, { idempotencyKey: 'k3' })).request.payload, big);
  const listed = (await current.session.pips.events('shop', { limit: 5 })).request;
  assert.deepEqual([listed.type, listed.app, listed.limit], ['list_app_events', 'shop', 5]);
  assert.equal((await current.session.pips.read('list_pip_routines', { pip_id: 'pip_x', app_events: true })).request.app_events, true);
});

test('plan mode refuses an app event', async () => {
  const planning = fixture(63, { permissionMode: 'plan' });
  await assert.rejects(planning.session.pips.trigger('shop', 'order.created', ORDER, { idempotencyKey: 'k' }), /plan mode/);
  assert.equal(planning.calls.length, 0);
});
