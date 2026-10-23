/** Pips API 61 in the TypeScript SDK: your app's tools (definePipTool, registerApp and the rest) and AppToolHandler
 *  (handle, express, fetch), which serves DGC's signed calls. Offline wire; no runtime, no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { Session, DGCConfigError, DGCUnsupportedError, AppToolHandler, PipToolError, definePipTool, signPipCall as sign }
  from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const SECRET = 'dgcapp_' + '1'.repeat(64);
const VECTOR = 'v1=1d8630eb99e1c2fa2d489e08c583f9bae3a4407eaf3d21797c9a1d8a597c542f';   // tests/test_dgc_sdk_pip_apps.py too
const unpaid = definePipTool('find_unpaid_orders', 'Orders unpaid after N days',
  { type: 'object', properties: { days: { type: 'integer' } }, required: ['days'] }, 'read');
const dispatch = definePipTool('create_dispatch', 'Create a dispatch for one order',
  { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] }, 'change');
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
const call = (tool = 'find_unpaid_orders', args = { days: 7 }, extra = {}) => ({ type: 'tool_call', app: 'shop', tool, arguments: args,
  pip_id: 'pip_' + 'a'.repeat(32), run_id: 'run_' + 'b'.repeat(32), call_id: 'call_' + 'c'.repeat(32), ...extra });
function signed(body, { secret = SECRET, timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex') } = {}) {
  const raw = JSON.stringify(body);
  return { headers: { 'X-DGC-Timestamp': timestamp, 'X-DGC-Nonce': nonce, 'X-DGC-Signature': sign(secret, timestamp, nonce, raw) }, body: raw };
}

test('your app\'s commands: known, refused before API 61, checked, then sent with the tools as the wire has them', async () => {
  assert.deepEqual([...COMMAND_FIELDS.register_app], ['name', 'url', 'tools']);
  assert.deepEqual([...COMMAND_FIELDS.update_app], ['name', 'url', 'tools']);
  assert.deepEqual([...COMMAND_FIELDS.accept_app_update], ['name', 'expected_digest']);
  assert.deepEqual([...COMMAND_FIELDS.list_apps], []);
  assert.deepEqual([...COMMAND_FIELDS.remove_app], ['name']);
  assert.deepEqual([...COMMAND_FIELDS.rotate_app_secret], ['name']);
  const old = fixture(60);
  await assert.rejects(old.session.pips.listApps(), (e) => e instanceof DGCUnsupportedError && /API 61/.test(e.message));
  await assert.rejects(old.session.pips.registerApp('shop', { url: 'https://shop.example.com/dgc/pips', tools: [unpaid] }, { approved: true }), DGCUnsupportedError);
  await assert.rejects(old.session.pips.mutate('propose_pip_update', { pip_id: 'pip_x', expected_version: 1, changes: { app_plan: {
    schema_version: 1, server: 'app:shop', connection_digest: '0'.repeat(64), calls: [] } } }, { approved: true }), /API 61/);
  assert.equal(old.calls.length, 0);
  const current = fixture(61);
  await assert.rejects(current.session.pips.registerApp('shop', { url: 'https://shop.example.com/', tools: [unpaid] }), DGCConfigError, 'not approved');
  for (const [name, url, tools] of [['Shop', 'https://shop.example.com/', [unpaid]], ['shop', 'http://shop.example.com/', [unpaid]],
    ['shop', 'https://shop.example.com/', []], ['shop', 'https://shop.example.com/', ['find']], ['shop', 'https://shop.example.com/', [{ ...unpaid, extra: 1 }]]]) {
    await assert.rejects(current.session.pips.registerApp(name, { url, tools }, { approved: true }), DGCConfigError, `${name} ${url}`);
  }
  await assert.rejects(current.session.pips.acceptAppUpdate('shop', 'nope', { approved: true }), DGCConfigError);
  assert.equal(current.calls.length, 0, 'nothing left the process');
  const sent = await current.session.pips.registerApp('shop', { url: 'http://127.0.0.1:5005/dgc/pips', tools: [unpaid, dispatch] }, { approved: true });
  assert.deepEqual(sent.request.tools, [
    { name: 'find_unpaid_orders', description: 'Orders unpaid after N days', input_schema: unpaid.inputSchema, kind: 'read' },
    { name: 'create_dispatch', description: 'Create a dispatch for one order', input_schema: dispatch.inputSchema, kind: 'change' }]);
  assert.equal((await current.session.pips.updateApp('shop', { tools: [unpaid] }, { approved: true })).request.tools.length, 1);
  assert.equal((await current.session.pips.listApps()).request.type, 'list_apps');
  assert.equal((await current.session.pips.acceptAppUpdate('shop', 'f'.repeat(64), { approved: true })).request.expected_digest, 'f'.repeat(64));
  for (const command of ['remove_app', 'rotate_app_secret']) {
    assert.equal((await current.session.pips.mutate(command, { name: 'shop' }, { approved: true })).request.name, 'shop');
  }
});

test('definePipTool checks what it describes', () => {
  const money = definePipTool('refund', 'Refund an order', { type: 'object' }, 'change', { movesMoney: true });
  assert.equal(money.movesMoney, true);
  for (const args of [['1bad', 'x', { type: 'object' }, 'read'], ['ok', '', { type: 'object' }, 'read'], ['ok', 'x', { type: 'object' }, 'write'],
    ['ok', 'x', { type: 'string' }, 'read'], ['ok', 'x', { type: 'object', properties: { a: { $ref: '#' } } }, 'read'],
    ['ok', 'x', { type: 'object', anyOf: [] }, 'read']]) {
    assert.throws(() => definePipTool(...args), DGCConfigError, JSON.stringify(args));
  }
  assert.throws(() => definePipTool('ok', 'x', { type: 'object' }, 'read', { movesMoney: true }), DGCConfigError);
});

function shop() {
  const ran = [];
  const handler = new AppToolHandler(SECRET, {
    find_unpaid_orders: (args, ctx) => { ran.push(ctx); return [{ id: 'ord_17', days: args.days }]; },
    create_dispatch: async (args, ctx) => {
      if (args.order_id === 'ord_99') throw new PipToolError("order ord_99 isn't unpaid");
      ran.push(ctx); return { dispatch: 'dsp_1', receipt: ctx.approvalId };
    },
  }, { definitions: [unpaid, dispatch] });
  return { handler, ran };
}
const parse = (out) => ({ status: out.status, body: JSON.parse(out.body) });

test('the signature is DGC\'s, and a signed call runs while anything else is refused', async () => {
  assert.equal(sign(SECRET, '1767225600', '0123456789abcdef0123456789abcdef', '{"type":"tool_call"}'), VECTOR);
  const { handler, ran } = shop();
  let request = signed(call());
  assert.deepEqual(parse(await handler.handle(request)), { status: 200, body: { ok: true, result: [{ id: 'ord_17', days: 7 }] } });
  assert.equal(ran[0].pipId, 'pip_' + 'a'.repeat(32));
  assert.equal(ran[0].actionId, null);
  assert.equal(parse(await handler.handle(request)).body.error.code, 'replayed');
  request = signed(call());
  assert.equal(parse(await handler.handle({ ...request, body: request.body.replace('7', '1') })).body.error.code, 'bad_signature');
  assert.equal(parse(await handler.handle(signed(call(), { timestamp: String(Math.floor(Date.now() / 1000) - 301) }))).body.error.code, 'stale');
  assert.equal(parse(await handler.handle(signed(call(), { secret: 'dgcapp_' + '2'.repeat(64) }))).body.error.code, 'bad_signature');
  assert.equal(parse(await handler.handle({ headers: {}, body: request.body })).body.error.code, 'unsigned');
  const lower = signed(call());
  assert.equal((await handler.handle({ headers: Object.fromEntries(Object.entries(lower.headers).map(([k, v]) => [k.toLowerCase(), v])), body: Buffer.from(lower.body) })).status, 200);
  const wrong = parse(await handler.handle(signed(call('find_unpaid_orders', { days: 'seven' }))));
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error.message, /\$\.days should be integer/);
  assert.equal((await handler.handle(signed(call('nope', {})))).status, 404);
  assert.equal(parse(await handler.handle(signed(call('create_dispatch', { order_id: 'ord_17' })))).body.error.code, 'not_accepted');
  const accepted = { action_id: 'appaction_' + 'd'.repeat(32), action_digest: 'e'.repeat(64) };
  assert.deepEqual(parse(await handler.handle(signed(call('create_dispatch', { order_id: 'ord_17' }, accepted)))).body,
    { ok: true, result: { dispatch: 'dsp_1', receipt: 'appaction_' + 'd'.repeat(32) } });
  assert.deepEqual(parse(await handler.handle(signed(call('create_dispatch', { order_id: 'ord_99' }, accepted)))),
    { status: 422, body: { ok: false, error: { code: 'tool_refused', message: "order ord_99 isn't unpaid" } } });
  const failed = [];
  const broken = new AppToolHandler(SECRET, { find_unpaid_orders: () => { throw new Error('database password is hunter2'); } },
    { definitions: [unpaid], onError: (error) => failed.push(error) });
  assert.deepEqual(parse(await broken.handle(signed(call()))), { status: 500, body: { ok: false, error: { code: 'tool_failed', message: 'The tool failed.' } } });
  assert.equal(failed.length, 1, 'its details stay in the app');
  assert.throws(() => new AppToolHandler(SECRET, { find_unpaid_orders: () => 1 }, { definitions: [] }), DGCConfigError);
  assert.throws(() => new AppToolHandler('', { find_unpaid_orders: () => 1 }, { definitions: [unpaid] }), DGCConfigError);
  const bounded = new AppToolHandler(SECRET, { find_unpaid_orders: () => 1 }, { definitions: [unpaid], maxNonces: 3 });
  for (let i = 0; i < 10; i++) assert.equal((await bounded.handle(signed(call()))).status, 200);
});

test('express and fetch serve it, and a body parsed before the handler is refused', async () => {
  const { handler } = shop();
  const respond = () => { const res = { headers: {} }; res.status = (s) => { res.code = s; return res; }; res.setHeader = (k, v) => { res.headers[k] = v; }; res.send = (b) => { res.body = b; }; return res; };
  const request = signed(call());
  const streamed = Object.assign(Readable.from([Buffer.from(request.body)]), { method: 'POST', headers: request.headers });
  let res = respond();
  await handler.express()(streamed, res);
  assert.equal(res.code, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  const raw = signed(call());
  res = respond();
  await handler.express()({ method: 'POST', headers: raw.headers, body: Buffer.from(raw.body) }, res);
  assert.equal(res.code, 200, 'express.raw()');
  const parsed = signed(call());
  res = respond();
  await handler.express()({ method: 'POST', headers: parsed.headers, body: JSON.parse(parsed.body) }, res);
  assert.equal(JSON.parse(res.body).error.code, 'parsed_body');
  const fetched = signed(call());
  const response = await handler.fetch(new Request('http://127.0.0.1/dgc/pips', { method: 'POST', headers: fetched.headers, body: fetched.body }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, result: [{ id: 'ord_17', days: 7 }] });
  assert.equal((await handler.fetch(new Request('http://127.0.0.1/dgc/pips'))).status, 405);
});
