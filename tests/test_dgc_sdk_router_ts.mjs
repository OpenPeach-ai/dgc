/** DGC Router in the TypeScript SDK: session.router (status, update, addSystem, setKey, probe, find, prefer), the
 *  router events among the known ones, and the Pips API 70 router model choice. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, Router, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { KNOWN_EVENTS } from '../sdk/typescript/src/transport.ts';

const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
const STATUS = { enabled: true, when_busy: 'wait', systems: [], workers: { total: 0, free: 0, busy: 0 }, line: '' };

function fixture(capabilities) {
  const calls = [];
  const wire = { request: async (payload, response, opts) => {
    calls.push(payload);
    if (payload.type === 'pips_control') {
      return { type: 'pips_result', request_id: opts.requestId, command: payload.request.type, ok: true, result: { request: payload.request } };
    }
    if (payload.type === 'router_suggest') {
      assert.equal(response, 'router_suggestion');
      return { type: 'router_suggestion', request_id: payload.request_id, suggestion: { system: payload.system, workers: 3 } };
    }
    assert.equal(response, 'router_status');
    return { type: 'router_status', request_id: payload.request_id, status: STATUS,
      ...(payload.type === 'router_hardware' ? { change: 'Read NAS\'s hardware from dgc node at http://nas.local:8577.' } : {}),
      ...(payload.type === 'router_update' ? { change: 'Turn DGC Router on' } : {}),
      ...(payload.type === 'router_probe' ? { probe: { system: payload.system, results: {} } } : {}),
      ...(payload.type === 'router_find' ? { found: { network: '10.9.8.0/24', found: [] } } : {}) };
  } };
  return { calls, session: new Session(wire, { capabilities }, init) };
}

test('the router events are known, so none is dropped', () => {
  assert.ok(KNOWN_EVENTS.has('router_status'));
  assert.ok(KNOWN_EVENTS.has('router_changed'));
});

test('session.router needs the capability', () => {
  assert.throws(() => fixture({}).session.router, DGCUnsupportedError);
});

test('each call is one router command', async () => {
  const { calls, session } = fixture({ router: { version: 1 } });
  const router = session.router;
  assert.ok(router instanceof Router);
  assert.deepEqual(await router.status(), STATUS);
  assert.equal((await router.update('turn_on')).change, 'Turn DGC Router on');
  await router.addSystem('gpu-box.local', { name: 'GPU box', jobs: ['subagents'] });
  await router.setKey('gpu-box', 'sk-123');
  assert.equal((await router.probe('gpu-box', { checks: ['speed'] })).system, 'gpu-box');
  assert.equal((await router.find()).network, '10.9.8.0/24');
  await router.prefer('nas', 'qwen3.5:9b');
  assert.deepEqual(calls.map((c) => c.type), ['router_status', 'router_update', 'router_update', 'router_update',
    'router_probe', 'router_find', 'router_update']);
  assert.equal(calls[2].action, 'add_system');
  assert.equal(calls[2].base_url, 'gpu-box.local');
  assert.equal(calls[3].key, 'sk-123');
  assert.deepEqual([calls[6].action, calls[6].system, calls[6].model], ['prefer', 'nas', 'qwen3.5:9b']);
});

test('a key goes only with set_key, and fields are checked', async () => {
  const router = fixture({ router: { version: 1 } }).session.router;
  await assert.rejects(router.update('add_system', { base_url: 'nas.local', key: 'sk-1' }), DGCConfigError);
  await assert.rejects(router.update('dance'), DGCConfigError);
  await assert.rejects(router.update('edit_system', { system: 'nas', colour: 'red' }), DGCConfigError);
});

test('a Pip on DGC Router: refused before Pips API 70, checked, then sent', async () => {
  const choice = { mode: 'router', system: 'nas', model: 'qwen3.5:9b' };
  const create = (s, c) => s.pips.mutate('create_pip', { workspace_id: 'ws', name: 'Inbox', goal: 'Help', model_choice: c }, { approved: true });
  const old = fixture({ pips_supported: true, pips_enabled: true, pips_api_version: 69 });
  await assert.rejects(create(old.session, choice), (e) => e instanceof DGCUnsupportedError && /API 70/.test(e.message));
  assert.equal(old.calls.length, 0);
  const current = fixture({ pips_supported: true, pips_enabled: true, pips_api_version: 70 });
  await assert.rejects(create(current.session, { mode: 'router', system: 'nas' }), DGCConfigError);
  assert.deepEqual((await create(current.session, choice)).request.model_choice, choice);
  assert.deepEqual((await create(current.session, { mode: 'router' })).request.model_choice, { mode: 'router' });
});

test('a permission request carries its choices: a DGC Router change offers no Always', async () => {
  const seen = [];
  const session = new Session({ request: async () => ({}) }, { capabilities: { permission_choices: 1 } },
    { ...init, options: { onPermission: (request) => { seen.push(request); return 'once'; } } });
  const run = { cancelled: () => new Promise(() => {}) };
  const answer = await session.permission(run, { id: 'p1', name: 'router_update', args: {}, choices: ['once', 'deny'] }, true);
  assert.equal(answer.action, 'once');
  assert.deepEqual(seen[0].choices, ['once', 'deny']);
  await session.permission(run, { id: 'p2', name: 'bash', args: {} }, true);
  assert.equal(seen[1].choices, undefined, 'a request that lists none has none');
});

test('hardware and suggest: new commands, a new event, refused by an older CLI', async () => {
  const commands = ['router_status', 'router_update', 'router_probe', 'router_find', 'router_hardware', 'router_suggest'];
  const { calls, session } = fixture({ router: { version: 1, commands } });
  const router = session.router;
  assert.match((await router.setHardware('nas', 'http://nas.local:8577', { token: 'dgcn_x' })).change, /dgc node/);
  await router.setHardware('nas');
  assert.equal((await router.suggest('nas', { context: 16384 })).workers, 3);
  await router.update('apply_suggestion', { system: 'nas', context: 16384 });
  assert.deepEqual(calls.map((c) => c.type), ['router_hardware', 'router_hardware', 'router_suggest', 'router_update']);
  assert.deepEqual([calls[0].url, calls[0].token], ['http://nas.local:8577', 'dgcn_x']);
  assert.ok(!('url' in calls[1]));
  assert.equal(calls[2].context, 16384);
  assert.ok(KNOWN_EVENTS.has('router_suggestion'));
  await assert.rejects(router.suggest('nas', { context: 1.5 }), DGCConfigError);
  const old = fixture({ router: { version: 1, commands: commands.slice(0, 4) } });
  await assert.rejects(old.session.router.setHardware('nas', 'nas.local:9100'), DGCUnsupportedError);
  await assert.rejects(old.session.router.suggest('nas'), DGCUnsupportedError);
  assert.equal(old.calls.length, 0);
});

test('a context by name, as Settings and dgc router read it', async () => {
  const commands = ['router_status', 'router_update', 'router_probe', 'router_find', 'router_hardware', 'router_suggest'];
  const { calls, session } = fixture({ router: { version: 1, commands } });
  const router = session.router;
  await router.update('set_model', { system: 'nas', model: 'qwen3:8b', context: '16K' });
  await router.update('set_model', { system: 'nas', model: 'qwen3:8b', context: '24,576' });
  await router.addSystem('gpu-box.local', { context: '8k' });
  await router.suggest('nas', { context: '32k' });
  assert.deepEqual(calls.map((c) => c.context), [16384, 24576, 8192, 32768]);
  for (const bad of ['1k', 'lots', true, 'nan', 'inf', 'infk', '1e5', '-16K', Number.NaN, Infinity]) {
    await assert.rejects(router.update('set_model', { system: 'nas', model: 'qwen3:8b', context: bad }), DGCConfigError);
  }
});
