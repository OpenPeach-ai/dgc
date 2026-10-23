/** Pips API 62 in the TypeScript SDK: approvals in your app. pips.pending and pips.decide (list_app_approvals and
 *  decide_app_approval, refused before API 62 and checked before anything is sent), and AppToolHandler's
 *  onApprovalRequested and onApprovalResolved (the same signature checks; 204 with no callback). Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Session, DGCConfigError, DGCUnsupportedError, AppToolHandler, definePipTool, signPipCall as sign } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const SECRET = 'dgcapp_' + '1'.repeat(64);
const ACTION = 'appaction_' + 'd'.repeat(32), DIGEST = 'e'.repeat(64);
const unpaid = definePipTool('find_unpaid_orders', 'Orders unpaid after N days',
  { type: 'object', properties: { days: { type: 'integer' } }, required: ['days'] }, 'read');
const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
function fixture(version) {
  const calls = [];
  const wire = { request: async (payload, response, opts) => {
    calls.push(payload);
    return { type: 'pips_result', request_id: opts.requestId, command: payload.request.type, ok: true, result: { request: payload.request } };
  } };
  return { calls, session: new Session(wire, { capabilities: { pips_supported: true, pips_enabled: true, pips_api_version: version } }, init) };
}
const requested = (extra = {}) => ({ type: 'approval_requested', app: 'shop', action_id: ACTION, action_digest: DIGEST, tool: 'create_dispatch',
  arguments: { order_id: 'ord_17' }, pip_id: 'pip_' + 'a'.repeat(32), pip_name: 'Asha', run_id: 'run_' + 'b'.repeat(32),
  summary: 'Asha asks to run create_dispatch (order_id ord_17) in Shop app.', expires_at: '2026-10-25T09:00:00.000Z', moves_money: false, ...extra });
const resolved = (extra = {}) => ({ type: 'approval_resolved', app: 'shop', action_id: ACTION, tool: 'create_dispatch', decision: 'accepted',
  by: 'app', at: '2026-10-24T09:01:00.000Z', ...extra });
function signed(body, { secret = SECRET, timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex') } = {}) {
  const raw = JSON.stringify(body);
  return { headers: { 'X-DGC-Timestamp': timestamp, 'X-DGC-Nonce': nonce, 'X-DGC-Signature': sign(secret, timestamp, nonce, raw) }, body: raw };
}

test('pending and decide: known, refused before API 62, checked, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.list_app_approvals], ['app']);
  assert.deepEqual([...COMMAND_FIELDS.decide_app_approval], ['action_id', 'decision', 'expected_digest']);
  const old = fixture(61);
  await assert.rejects(old.session.pips.pending(), (e) => e instanceof DGCUnsupportedError && /API 62/.test(e.message));
  await assert.rejects(old.session.pips.decide(ACTION, 'accept', DIGEST, { approved: true }), /API 62/);
  assert.equal(old.calls.length, 0);
  const current = fixture(62);
  await assert.rejects(current.session.pips.decide(ACTION, 'accept', DIGEST), DGCConfigError, 'not approved');
  for (const [id, decision, digest] of [[ACTION, 'allow', DIGEST], ['appaction_x', 'accept', DIGEST], ['conndraft_' + 'd'.repeat(32), 'accept', DIGEST], [ACTION, 'reject', 'nope']]) {
    await assert.rejects(current.session.pips.decide(id, decision, digest, { approved: true }), DGCConfigError, `${id} ${decision}`);
  }
  await assert.rejects(current.session.pips.pending('Shop'), DGCConfigError);
  assert.equal(current.calls.length, 0, 'nothing left the process');
  const all = await current.session.pips.pending();
  assert.equal(all.request.type, 'list_app_approvals');
  assert.equal(Object.hasOwn(all.request, 'app'), false);
  assert.equal((await current.session.pips.pending('shop')).request.app, 'shop');
  const sent = (await current.session.pips.decide(ACTION, 'reject', DIGEST, { approved: true })).request;
  assert.deepEqual({ type: sent.type, action_id: sent.action_id, decision: sent.decision, expected_digest: sent.expected_digest },
    { type: 'decide_app_approval', action_id: ACTION, decision: 'reject', expected_digest: DIGEST });
});

test('without a callback the handler answers 204, after the same checks', async () => {
  const quiet = new AppToolHandler(SECRET, { find_unpaid_orders: () => [] }, { definitions: [unpaid] });
  for (const body of [requested(), resolved()]) {
    const out = await quiet.handle(signed(body));
    assert.deepEqual([out.status, out.body], [204, ''], body.type);
  }
  assert.equal(JSON.parse((await quiet.handle(signed(requested(), { secret: 'dgcapp_' + '2'.repeat(64) }))).body).error.code, 'bad_signature');
  const once = signed(requested());
  assert.equal((await quiet.handle(once)).status, 204);
  assert.equal(JSON.parse((await quiet.handle(once)).body).error.code, 'replayed');
  assert.equal((await quiet.handle(signed(requested(), { timestamp: '1' }))).status, 401);
  const response = await quiet.fetch(new Request('http://127.0.0.1/dgc/pips', { method: 'POST', ...signed(resolved()) }));
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
});

test('a callback gets the event once its signature checks out, and a failing one answers 500', async () => {
  const seen = [], failed = [];
  const handler = new AppToolHandler(SECRET, { find_unpaid_orders: () => [] }, { definitions: [unpaid],
    onApprovalRequested: async (event) => { seen.push(event); }, onApprovalResolved: (event) => { seen.push(event); } });
  assert.deepEqual(JSON.parse((await handler.handle(signed(requested()))).body), { ok: true });
  assert.deepEqual({ ...seen[0] }, { type: 'approval_requested', app: 'shop', actionId: ACTION, actionDigest: DIGEST, tool: 'create_dispatch',
    arguments: { order_id: 'ord_17' }, pipId: 'pip_' + 'a'.repeat(32), pipName: 'Asha', runId: 'run_' + 'b'.repeat(32),
    summary: 'Asha asks to run create_dispatch (order_id ord_17) in Shop app.', expiresAt: '2026-10-25T09:00:00.000Z', movesMoney: false });
  assert.equal((await handler.handle(signed(resolved({ decision: 'expired', by: 'dgc' })))).status, 200);
  assert.deepEqual([seen[1].type, seen[1].decision, seen[1].by], ['approval_resolved', 'expired', 'dgc']);
  const tampered = signed(requested());
  assert.equal((await handler.handle({ ...tampered, body: tampered.body.replace('ord_17', 'ord_99') })).status, 401);
  assert.equal((await handler.handle({ headers: {}, body: tampered.body })).status, 401);
  for (const bad of [requested({ action_id: 'x' }), requested({ action_digest: 'y' }), requested({ moves_money: 'no' }), resolved({ decision: 'maybe' }),
    { type: 'approval_resolved', app: 'shop' }]) {
    const out = await handler.handle(signed(bad));
    assert.deepEqual([out.status, JSON.parse(out.body).error.code], [400, 'invalid_request'], JSON.stringify(bad));
  }
  assert.equal(seen.length, 2, 'none of those reached a callback');
  const broken = new AppToolHandler(SECRET, { find_unpaid_orders: () => [] }, { definitions: [unpaid],
    onApprovalRequested: () => { throw new Error('database password is hunter2'); }, onError: (error) => failed.push(error) });
  const out = await broken.handle(signed(requested()));
  assert.deepEqual([out.status, JSON.parse(out.body).error.code], [500, 'callback_failed']);
  assert.doesNotMatch(out.body, /hunter2/);
  assert.equal(failed.length, 1, 'its details stay in the app');
  assert.throws(() => new AppToolHandler(SECRET, { find_unpaid_orders: () => [] }, { definitions: [unpaid], onApprovalResolved: 'nope' }), DGCConfigError);
  const tool = signed({ type: 'tool_call', app: 'shop', tool: 'find_unpaid_orders', arguments: { days: 7 }, pip_id: 'pip_' + 'a'.repeat(32),
    run_id: 'run_' + 'b'.repeat(32), call_id: 'call_' + 'c'.repeat(32) });
  assert.deepEqual(JSON.parse((await handler.handle(tool)).body), { ok: true, result: [] }, 'a tool call is still a tool call');
});
