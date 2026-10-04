/** Offline Pips SDK authority/correlation tests. No sleeps or network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DGC, Session, DGCConfigError, DGCUnsupportedError, DGCProtocolError, DGCCommandRejectedError } from '../sdk/typescript/src/index.ts';
import { Transport } from '../sdk/typescript/src/transport.ts';
import { COMMAND_FIELDS, Pips } from '../sdk/typescript/src/pips.ts';

const caps = { pips_supported: true, pips_api_version: 8, pips_enabled: true };
const pulseRun = { pip_id: 'pip_pulse', idempotency_key: 'reviewed-one', expected_version: 4,
  expected_lifecycle_revision: 2, expected_plan_digest: 'a'.repeat(64) };
const pulsePlan = { schema_version: 1, action: { kind: 'test', tests: [
  { argv: ['/usr/bin/python3', '-c', 'print("$HOME; $(never-expanded)")'], cwd: '.' }], network: false,
  limits: { wall_seconds: 60, cpu_seconds: 30, memory_bytes: 536870912, output_bytes: 65536, processes: 32 } } };
const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
function fixture(capabilities = caps, changes = {}) {
  const calls = [];
  const wire = { request: async (payload, response, opts) => {
    calls.push({ payload, response, opts });
    const request = payload.request;
    return { type: 'pips_result', request_id: opts.requestId, command: request.type, ok: true, result: { request } };
  } };
  return { calls, wire, session: new Session(wire, { capabilities }, { ...init, ...changes }) };
}

const commitPathPolicy = { events: ['committed_paths_changed'], minimum_minutes: 5, missed_policy: 'coalesce_latest',
  commit_paths: [{ kind: 'directory', path: 'src' }, { kind: 'exact', path: 'docs/日本語.md' }] };
const commitPathProposal = trigger => ({ pip_id: 'pip_reviewed', expected_version: 7,
  reason: 'Review literal committed paths', changes: { event_trigger: structuredClone(trigger) } });

test('API22 gates the new event or field presence, without changing legacy triggers', async () => {
  for (const version of [10, 17, 18, 20, 21]) {
    const old = fixture({ ...caps, pips_api_version: version });
    for (const trigger of [commitPathPolicy, { events: ['committed_paths_changed'] },
      { events: ['commit_changed'], commit_paths: null }, { commit_paths: [] }]) {
      await assert.rejects(old.session.pips.mutate('propose_pip_update', commitPathProposal(trigger), { approved: true }), /API 22/);
    }
    assert.equal(old.calls.length, 0);
    for (const trigger of [null, { events: ['context_updated'] }, { events: ['commit_changed', 'finding_accepted'] }]) {
      const result = await old.session.pips.mutate('propose_pip_update', commitPathProposal(trigger), { approved: true });
      assert.deepEqual(result.request.changes.event_trigger, trigger);
    }
    assert.equal(old.calls.length, 3);
  }
});

test('API22 forwards detached literal rules once and requires separate proposal/accept approval', async () => {
  const current = fixture({ ...caps, pips_api_version: 22 });
  const params = commitPathProposal(commitPathPolicy); const before = structuredClone(params);
  for (const [command, values] of [['propose_pip_update', params], ['accept_pip_update',
    { pip_id: 'pip_reviewed', expected_version: 7, proposal_id: 'proposal_saved' }]]) {
    for (const approved of [false, null, 1, 'true']) {
      await assert.rejects(current.session.pips.mutate(command, values, { approved }), DGCConfigError);
    }
    await current.session.pips.mutate(command, values, { approved: true });
  }
  params.changes.event_trigger.commit_paths[0].path = 'changed later';
  assert.deepEqual(current.calls[0].payload.request.changes, before.changes);
  assert.deepEqual(current.calls.map(x => x.payload.request.type), ['propose_pip_update', 'accept_pip_update']);
});

test('API22 refusal is not retried, rebased, queried or downgraded to broad commits', async () => {
  const current = fixture({ ...caps, pips_api_version: 22 }); const send = current.wire.request;
  current.wire.request = async (...args) => ({ ...await send(...args), ok: false,
    error: { code: 'conflict', message: 'Review the current job.' } });
  await assert.rejects(current.session.pips.mutate('propose_pip_update', commitPathProposal(commitPathPolicy),
    { approved: true }), error => error instanceof DGCCommandRejectedError && error.reason === 'conflict');
  assert.equal(current.calls.length, 1); assert.equal(current.calls[0].payload.request.expected_version, 7);
  assert.deepEqual(current.calls[0].payload.request.changes.event_trigger, commitPathPolicy);
});

test('API22 does not override disabled Pips, isolation, policy, sandbox or plan mode', async () => {
  for (const changes of [{ isolated: true }, { policy: {} }, { permissionMode: 'plan' },
    { sandbox: { requirement: 'required', active: false } }, { sandbox: { requirement: 'off', active: true } }]) {
    const restricted = fixture({ ...caps, pips_api_version: 22 }, changes);
    await assert.rejects(restricted.session.pips.mutate('propose_pip_update', commitPathProposal(commitPathPolicy),
      { approved: true }), DGCUnsupportedError);
    assert.equal(restricted.calls.length, 0);
  }
  const disabled = fixture({ ...caps, pips_api_version: 22, pips_enabled: false });
  await assert.rejects(disabled.session.pips.mutate('propose_pip_update', commitPathProposal(commitPathPolicy),
    { approved: true }), DGCUnsupportedError);
  assert.equal(disabled.calls.length, 0);
});

test('API21 Pulse new fields gate before transport, including plan removal', async () => {
  for (const version of [8, 19, 20]) {
    const old = fixture({ ...caps, pips_api_version: version });
    for (const verification_plan of [null, pulsePlan]) {
      await assert.rejects(old.session.pips.mutate('propose_pip_update', {
        pip_id: 'pip_pulse', expected_version: 3, reason: 'Human review', changes: { verification_plan },
      }, { approved: true }), /API 21/);
    }
    for (const field of ['expected_version', 'expected_lifecycle_revision', 'expected_plan_digest']) {
      await assert.rejects(old.session.pips.mutate('run_pip', {
        pip_id: pulseRun.pip_id, idempotency_key: pulseRun.idempotency_key, [field]: pulseRun[field],
      }, { approved: true }), /API 21/);
    }
    assert.equal(old.calls.length, 0);
  }
});

test('API21 Pulse plan, separate acceptance and exact run pins require approval and forward once', async () => {
  const current = fixture({ ...caps, pips_api_version: 21 });
  const params = { pip_id: 'pip_pulse', expected_version: 3, reason: 'Human reviewed exact commands',
    changes: { verification_plan: structuredClone(pulsePlan) } };
  const before = structuredClone(params);
  for (const [command, values] of [
    ['propose_pip_update', params],
    ['accept_pip_update', { pip_id: 'pip_pulse', proposal_id: 'proposal_saved', expected_version: 3 }],
    ['run_pip', pulseRun],
  ]) {
    for (const approved of [false, null, 1, 'true']) {
      await assert.rejects(current.session.pips.mutate(command, values, { approved }), DGCConfigError);
    }
    await current.session.pips.mutate(command, values, { approved: true });
  }
  params.changes.verification_plan.action.tests[0].argv[2] = 'changed later';
  assert.deepEqual(current.calls[0].payload.request.changes, before.changes);
  assert.deepEqual(current.calls.map(x => x.payload.request.type), ['propose_pip_update', 'accept_pip_update', 'run_pip']);
  for (const key of Object.keys(pulseRun)) assert.deepEqual(current.calls[2].payload.request[key], pulseRun[key]);
  assert.deepEqual([...COMMAND_FIELDS.run_pip].sort(), Object.keys(pulseRun).sort());
});

test('API21 leaves old auditors alone and never rebases or retries stale Pulse requests', async () => {
  const old = fixture();
  await old.session.pips.mutate('run_pip', { pip_id: 'pip_rook', idempotency_key: 'one' }, { approved: true });
  await old.session.pips.mutate('propose_pip_update', { pip_id: 'pip_rook', expected_version: 1, reason: 'Review',
    changes: { schedule: { type: 'interval', minutes: 30 } } }, { approved: true });
  assert.equal(old.calls.length, 2);
  const current = fixture({ ...caps, pips_api_version: 21 });
  const send = current.wire.request;
  current.wire.request = async (...args) => ({ ...await send(...args), ok: false,
    error: { code: 'stale_grant', message: 'Review the saved job again.' } });
  await assert.rejects(current.session.pips.mutate('run_pip', pulseRun, { approved: true }), error => {
    assert.ok(error instanceof DGCCommandRejectedError); assert.equal(error.reason, 'stale_grant'); return true;
  });
  assert.equal(current.calls.length, 1);
  assert.equal(current.calls[0].payload.request.expected_version, 4);
  for (const key of ['actor', 'argv', 'permissions', 'pulse_verification', 'result', 'project_root']) {
    await assert.rejects(current.session.pips.mutate('run_pip', { ...pulseRun, [key]: 'forged' }, { approved: true }), DGCConfigError);
  }
  assert.equal(current.calls.length, 1);
});

test('API21 never overrides isolation, disabled Pips, runtime policy, sandbox or plan mode', async () => {
  for (const changes of [{ isolated: true }, { policy: {} }, { permissionMode: 'plan' },
    { sandbox: { requirement: 'required', active: false } }, { sandbox: { requirement: 'off', active: true } }]) {
    const restricted = fixture({ ...caps, pips_api_version: 21 }, changes);
    await assert.rejects(restricted.session.pips.mutate('run_pip', pulseRun, { approved: true }), DGCUnsupportedError);
    assert.equal(restricted.calls.length, 0);
  }
  const disabled = fixture({ ...caps, pips_api_version: 21, pips_enabled: false });
  await assert.rejects(disabled.session.pips.mutate('run_pip', pulseRun, { approved: true }), DGCUnsupportedError);
  assert.equal(disabled.calls.length, 0);
});

test('API18 saved turn event requires the new capability and explicit review', async () => {
  const params = { pip_id: 'pip_a', expected_version: 2, reason: 'Review saved turn trigger',
    changes: { event_trigger: { events: ['session_turn_completed'], minimum_minutes: 30 } } };
  const old = fixture({ ...caps, pips_api_version: 17 });
  await assert.rejects(old.session.pips.mutate('propose_pip_update', params, { approved: true }), /API 18/);
  assert.equal(old.calls.length, 0);
  const current = fixture({ ...caps, pips_api_version: 18 });
  await assert.rejects(current.session.pips.mutate('propose_pip_update', params), DGCConfigError);
  const result = await current.session.pips.mutate('propose_pip_update', params, { approved: true });
  assert.deepEqual(result.request.changes, params.changes);
  assert.equal(current.calls.length, 1);
  for (const trigger of [null, { events: ['context_updated'] }, { events: ['finding_accepted', 'commit_changed'] }]) {
    await old.session.pips.mutate('propose_pip_update', { ...params, changes: { event_trigger: trigger } }, { approved: true });
  }
  assert.equal(old.calls.length, 3);
});

test('API17 native receipt recording requires reviewed pins and explicit mutation approval', async () => {
  const commands = {
    list_workspace_execution_receipts: { workspace_id: 'ws_a', session_id: 'chat-one', limit: 20 },
    get_workspace_execution_receipt: { workspace_id: 'ws_a', attempt_id: 'exec_a' },
    record_workspace_execution_context: { workspace_id: 'ws_a', attempt_id: 'exec_a',
      expected_attempt_digest: 'a'.repeat(64), expected_final_digest: 'b'.repeat(64),
      expected_view_digest: 'c'.repeat(64), expected_context_revision: 3 },
  };
  for (const [command, params] of Object.entries(commands)) {
    const mutation = command === 'record_workspace_execution_context';
    const old = fixture({ ...caps, pips_api_version: 16 });
    await assert.rejects(mutation ? old.session.pips.mutate(command, params, { approved: true })
      : old.session.pips.read(command, params), DGCUnsupportedError);
    assert.equal(old.calls.length, 0);
    const current = fixture({ ...caps, pips_api_version: 17 });
    if (mutation) {
      await assert.rejects(current.session.pips.read(command, params), DGCConfigError);
      await assert.rejects(current.session.pips.mutate(command, params), DGCConfigError);
      await current.session.pips.mutate(command, params, { approved: true });
    } else {
      await assert.rejects(current.session.pips.mutate(command, params, { approved: true }), DGCConfigError);
      await current.session.pips.read(command, params);
    }
    for (const key of ['actor', 'project_root', 'command', 'verified', 'permissions']) {
      await assert.rejects(mutation ? current.session.pips.mutate(command, { ...params, [key]: 'forged' }, { approved: true })
        : current.session.pips.read(command, { ...params, [key]: 'forged' }), DGCConfigError);
    }
    assert.equal(current.calls.length, 1);
    for (const key of Object.keys(params)) assert.deepEqual(current.calls[0].payload.request[key], params[key]);
  }
});

test('API14 source-exception review stays distinct from execution and SDK read authority', async () => {
  const commands = {
    get_pip_exception_source: { pip_id: 'pip_a', run_id: 'run_a', finding_index: 0 },
    list_pip_memories: { pip_id: 'pip_a', before_id: 5, limit: 20 },
    record_pip_exception: { pip_id: 'pip_a', run_id: 'run_a', finding_index: 0,
      expected_source_digest: 'a'.repeat(64), reason: 'Reviewed local exception', expires_at: null, request_key: 'one' },
    revoke_pip_exception: { pip_id: 'pip_a', memory_id: 'memory_a', expected_revision: 0, reason: 'Revisit' },
  };
  for (const [command, params] of Object.entries(commands)) {
    const read = ['get_pip_exception_source', 'list_pip_memories'].includes(command);
    const old = fixture({ ...caps, pips_api_version: 13 });
    await assert.rejects(read ? old.session.pips.read(command, params)
      : old.session.pips.mutate(command, params, { approved: true }), DGCUnsupportedError);
    assert.equal(old.calls.length, 0);
    const current = fixture({ ...caps, pips_api_version: 14 });
    if (read) {
      await current.session.pips.read(command, params);
      await assert.rejects(current.session.pips.mutate(command, params, { approved: true }), DGCConfigError);
    } else {
      await assert.rejects(current.session.pips.mutate(command, params), DGCConfigError);
      await current.session.pips.mutate(command, params, { approved: true });
    }
    const forged = { ...params, permissions: { allow: ['Bash'] } };
    await assert.rejects(read ? current.session.pips.read(command, forged)
      : current.session.pips.mutate(command, forged, { approved: true }), DGCConfigError);
    assert.equal(current.calls.length, 1);
    assert.equal(current.calls[0].payload.request.type, command);
  }
});

test('API15 gates reviewed specialists while old handoffs retain API8 compatibility', async () => {
  const values = { source_run_id: 'run_a', finding_index: 0, target_pip_id: 'pip_a', task: 'Review a fix',
    action: { kind: 'patch', write_paths: ['one.py'], tests: [] }, idempotency_key: 'one' };
  await fixture().session.pips.mutate('propose_pip_handoff', values, { approved: true });
  const next = { ...values, action: { ...values.action, specialists: { roles: ['critic'], max_calls: 1 } } };
  const old = fixture({ ...caps, pips_api_version: 14 });
  await assert.rejects(old.session.pips.mutate('propose_pip_handoff', next, { approved: true }), DGCUnsupportedError);
  assert.equal(old.calls.length, 0);
  const current = fixture({ ...caps, pips_api_version: 15 });
  await assert.rejects(current.session.pips.mutate('propose_pip_handoff', next), DGCConfigError);
  await current.session.pips.mutate('propose_pip_handoff', next, { approved: true });
  assert.deepEqual(current.calls[0].payload.request.action.specialists, { roles: ['critic'], max_calls: 1 });
});

test('API13 inbox acknowledgement is a separately approved mutation, including retries', async () => {
  const commands = { list_pip_notifications: { workspace_id: 'ws_a', limit: 20 },
    mark_pip_notification_read: { notification_id: 'notification_a', expected_revision: 0 } };
  for (const [command, params] of Object.entries(commands)) {
    const read = command === 'list_pip_notifications';
    const old = fixture({ ...caps, pips_api_version: 12 });
    await assert.rejects(read ? old.session.pips.read(command, params)
      : old.session.pips.mutate(command, params, { approved: true }), DGCUnsupportedError);
    assert.equal(old.calls.length, 0);
    const current = fixture({ ...caps, pips_api_version: 13 });
    if (read) {
      await assert.rejects(current.session.pips.mutate(command, params, { approved: true }), DGCConfigError);
      await current.session.pips.read(command, params);
    } else {
      for (let i = 0; i < 2; i++) {
        await assert.rejects(current.session.pips.mutate(command, params), DGCConfigError);
        await current.session.pips.mutate(command, params, { approved: true });
      }
    }
    const sent = current.calls.length;
    await assert.rejects(read ? current.session.pips.read(command, { ...params, actor: 'forged' })
      : current.session.pips.mutate(command, { ...params, actor: 'forged' }, { approved: true }), DGCConfigError);
    assert.equal(current.calls.length, sent);
    assert.equal(current.calls[0].payload.request.type, command);
  }
});

test('nested correlation, original params detached, convenience reads never enqueue', async () => {
  const { session, calls } = fixture();
  const values = { workspace_id: 'ws_a' };
  await session.pips.read('list_pips', values);
  assert.deepEqual(Object.keys(calls[0].payload), ['type', 'request']);
  assert.equal(calls[0].opts.requestId, calls[0].payload.request.request_id);
  assert.deepEqual(values, { workspace_id: 'ws_a' });
  await session.pips.get('pip_a'); await session.pips.runs('pip_a'); await session.pips.getRun('run_a'); await session.pips.list('ws_a');
  assert.equal(new Set(calls.map(c => c.opts.requestId)).size, 5);
  assert.deepEqual(calls.map(c => c.payload.request.type), ['list_pips', 'get_pip', 'list_pip_runs', 'get_pip_run', 'list_pips']);
});

test('every mutation needs exact explicit approval, including retry', async () => {
  const { session, calls } = fixture();
  for (const approved of [undefined, false, null, 1, 'true']) {
    await assert.rejects(session.pips.mutate('pause_pip', { pip_id: 'pip_a' }, { approved }), DGCConfigError);
  }
  await assert.rejects(session.pips.mutate('pause_pip', { pip_id: 'pip_a' }), DGCConfigError);
  assert.equal(calls.length, 0);
  await session.pips.mutate('pause_pip', { pip_id: 'pip_a' }, { approved: true });
  await assert.rejects(session.pips.mutate('pause_pip', { pip_id: 'pip_a' }), DGCConfigError);
  assert.equal(calls.length, 1);
});

test('enable, runtime, future and misclassified commands never reach transport', async () => {
  const { session, calls } = fixture();
  for (const command of ['pips_enable', 'pips_runtime', 'future', 'run_pip']) {
    await assert.rejects(session.pips.read(command, {}), DGCConfigError);
  }
  for (const command of ['pips_enable', 'pips_runtime', 'future', 'list_pips']) {
    await assert.rejects(session.pips.mutate(command, {}, { approved: true }), DGCConfigError);
  }
  assert.equal(calls.length, 0);
});

test('missing, old or malformed capabilities fail closed; API9 promotion additive', async () => {
  for (const capabilities of [{}, { ...caps, pips_supported: 1 }, { ...caps, pips_enabled: false },
    { ...caps, pips_api_version: 7 }, { ...caps, pips_api_version: true }, { ...caps, pips_api_version: '8' }]) {
    const { session, calls } = fixture(capabilities);
    await assert.rejects(session.pips.read('list_workspaces', {}), DGCUnsupportedError);
    assert.equal(calls.length, 0);
  }
  const values = { workspace_id: 'ws_a', run_id: 'run_a', expected_revision: 0, expected_review_revision: 1 };
  await assert.rejects(fixture().session.pips.mutate('accept_pip_execution_context', values, { approved: true }), DGCUnsupportedError);
  await fixture({ ...caps, pips_api_version: 9 }).session.pips.mutate('accept_pip_execution_context', values, { approved: true });
});

test('API12 session statements require advertised support and explicit mutation approval', async () => {
  const reads = {
    list_workspace_sessions: { workspace_id: 'ws_a', after: '', limit: 20 },
    inspect_workspace_session_outcome: { workspace_id: 'ws_a', session_id: 'session_a' },
    get_workspace_session_outcome: { workspace_id: 'ws_a', proposal_id: 'outcome_a' },
    list_workspace_session_outcomes: { workspace_id: 'ws_a', limit: 20 },
  };
  const mutations = {
    propose_workspace_session_outcome: { workspace_id: 'ws_a', session_id: 'session_a', title: 'Decision',
      statement: 'A user statement, not execution evidence.', source: { kind: 'commit', revision: 'a'.repeat(40) },
      expected_session_revision: 3, request_key: 'one' },
    accept_workspace_session_outcome: { workspace_id: 'ws_a', proposal_id: 'outcome_a', expected_digest: 'a'.repeat(64), expected_context_revision: 0 },
    reject_workspace_session_outcome: { workspace_id: 'ws_a', proposal_id: 'outcome_a', expected_digest: 'a'.repeat(64) },
  };
  for (const [command, params] of Object.entries({ ...reads, ...mutations })) {
    const read = Object.hasOwn(reads, command);
    const old = fixture({ ...caps, pips_api_version: 11 });
    await assert.rejects(read ? old.session.pips.read(command, params)
      : old.session.pips.mutate(command, params, { approved: true }), DGCUnsupportedError);
    assert.equal(old.calls.length, 0);
    const current = fixture({ ...caps, pips_api_version: 12 });
    if (!read) {
      await assert.rejects(current.session.pips.mutate(command, params), DGCConfigError);
      assert.equal(current.calls.length, 0);
      await current.session.pips.mutate(command, params, { approved: true });
    } else {
      await assert.rejects(current.session.pips.mutate(command, params, { approved: true }), DGCConfigError);
      await current.session.pips.read(command, params);
    }
    await assert.rejects(read ? current.session.pips.read(command, { ...params, session_path: '/outside' })
      : current.session.pips.mutate(command, { ...params, session_path: '/outside' }, { approved: true }), DGCConfigError);
    assert.equal(current.calls.length, 1);
    assert.equal(current.calls[0].payload.request.type, command);
  }
});

test('foreground policy and sandbox cannot authorize independent Pip access', async () => {
  for (const changes of [{ isolated: true }, { policy: {} }, { sandbox: { ...init.sandbox, active: true } },
    { sandbox: { ...init.sandbox, requirement: 'required' } }, { sandbox: { ...init.sandbox, requirement: 'preferred' } }]) {
    const { session, calls } = fixture(caps, changes);
    await assert.rejects(session.pips.read('list_workspaces', {}), DGCUnsupportedError);
    await assert.rejects(session.pips.mutate('run_pip', { pip_id: 'pip_a', idempotency_key: 'once' }, { approved: true }), DGCUnsupportedError);
    assert.equal(calls.length, 0);
  }
  const { session } = fixture(caps, { permissionMode: 'plan' });
  await session.pips.read('list_workspaces', {});
  await assert.rejects(session.pips.mutate('pause_pip', { pip_id: 'pip_a' }, { approved: true }), DGCUnsupportedError);
});

test('bounded JSON, reserved fields, invalid Unicode and non-data properties refused before send', async () => {
  const { session, calls } = fixture();
  const cycle = {}; cycle.workspace_id = cycle;
  let deep = []; for (let i = 0; i < 14; i++) deep = [deep];
  let getterRan = false;
  const getter = { get workspace_id() { getterRan = true; return 'ws_a'; } };
  for (const value of [{ type: 'run_pip' }, { request_id: 'forged' }, { api_key: 'secret' },
    { workspace_id: '\ud800' }, { workspace_id: 'x'.repeat(40000) }, { workspace_id: '界'.repeat(12000) },
    { workspace_id: NaN }, { workspace_id: 2 ** 54 }, { workspace_id: undefined }, { workspace_id: () => 1 },
    { workspace_id: Array(2049).fill(1) }, { workspace_id: deep }, cycle, getter, [], new Date()]) {
    await assert.rejects(session.pips.read('list_pips', value), DGCConfigError);
  }
  assert.equal(getterRan, false); assert.equal(calls.length, 0);
  const values = { pip_id: 'pip_a', changes: { goal: 'new' }, expected_version: 1, reason: 'review' };
  await session.pips.mutate('propose_pip_update', values, { approved: true });
  values.changes.goal = 'changed';
  assert.equal(calls[0].payload.request.changes.goal, 'new');
});

test('response mismatches refuse; structured backend failures retain command and reason', async () => {
  for (const changes of [{ request_id: 'wrong' }, { command: 'run_pip' }, { ok: 1 }, { result: null },
    { result: [] }, { ok: false, error: {} }, { ok: false, error: { code: 1, message: 'error' } }]) {
    const { session, wire } = fixture();
    const request = wire.request;
    wire.request = async (...args) => ({ ...await request(...args), ...changes });
    await assert.rejects(session.pips.read('list_workspaces', {}), DGCProtocolError);
  }
  const { session, wire } = fixture();
  const request = wire.request;
  wire.request = async (...args) => ({ ...await request(...args), ok: false, error: { code: 'stale_version', message: 'Review again' } });
  await assert.rejects(session.pips.mutate('pause_pip', { pip_id: 'pip_a' }, { approved: true }), error => {
    assert.ok(error instanceof DGCCommandRejectedError);
    assert.equal(error.command, 'pause_pip'); assert.equal(error.reason, 'stale_version'); return true;
  });
});

test('non-Pip commands keep existing outer correlation', async () => {
  const { session, wire } = fixture();
  wire.request = async (payload, response, options) => {
    assert.equal(typeof payload.request_id, 'string'); assert.equal(options.requestId, undefined);
    return { items: [] };
  };
  assert.deepEqual(await session.listSessions(), []);
});

test('API command field map mirrors Python SDK', () => {
  const source = readFileSync(new URL('../sdk/python/dgc_sdk/pips.py', import.meta.url), 'utf8');
  for (const [name, fields] of Object.entries(COMMAND_FIELDS)) {
    assert.ok(source.includes(`'${name}': frozenset(`), name);
    for (const field of fields) assert.ok(source.includes(`'${field}'`), field);
  }
});

const runtime = `
import readline from 'node:readline';
let seq = 0, pending = [];
const emit = (type, fields) => process.stdout.write(JSON.stringify({ type, seq: seq++, ...fields }) + '\\n');
emit('ready', { version:'fixture',protocol_version:14,capabilities:${JSON.stringify(caps)},model:'fixture',mode:'default',think:'off',base_url:'http://127.0.0.1:1/v1',workspace_trusted:false,commands:[],custom_commands:[],goal:{text:'',status:'none'},context_size:32768 });
readline.createInterface({ input:process.stdin }).on('line', line => {
 const cmd = JSON.parse(line);
 if (cmd.type === 'shutdown') process.exit(0);
 if (Object.keys(cmd).sort().join(',') !== 'request,type') throw Error('undeclared outer field');
 pending.push(cmd.request);
 if (pending.length === 2) {
   emit('info', { message:'unrelated event retained' });
   for (const r of pending.reverse()) {
     if(r.pip_id==='rejected_command') emit('command_rejected',{request_id:r.request_id,command:'pips_control',reason:'session_policy',message:'policy fixture'});
     else if(r.pip_id==='rejected_control') emit('pips_result',{request_id:r.request_id,command:r.type,ok:false,error:{code:'not_found',message:'control fixture'}});
     else emit('pips_result', { request_id:r.request_id,command:r.type,ok:true,result:{pip_id:r.pip_id} });
   }
   pending=[];
 }
});
`;

test('real transport routes reversed concurrent nested replies without stealing unrelated events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dgc-sdk-pips-'));
  const path = join(directory, 'runtime.mjs'); writeFileSync(path, runtime);
  const transport = new Transport([process.execPath, path], directory, process.env);
  try {
    const ready = await transport.start(10000);
    const session = new Session(transport, ready, init);
    const [a, b] = await Promise.all([session.pips.get('pip_a'), session.pips.get('pip_b')]);
    assert.deepEqual(a, { pip_id: 'pip_a' }); assert.deepEqual(b, { pip_id: 'pip_b' });
    const errors = await Promise.allSettled([session.pips.get('rejected_command'), session.pips.get('rejected_control')]);
    for (const [index, entry] of errors.entries()) {
      assert.equal(entry.status, 'rejected'); assert.ok(entry.reason instanceof DGCCommandRejectedError);
      assert.equal(entry.reason.reason, index === 0 ? 'session_policy' : 'not_found');
    }
    assert.equal((await transport.next(1000)).message, 'unrelated event retained');
  } finally { await transport.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('explicit inherited controller reads the actual backend without network, config changes or runner startup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dgc-sdk-pips-real-'));
  const home = join(directory, 'home'), workspace = join(directory, 'workspace');
  mkdirSync(join(home, '.dgc'), { recursive: true, mode: 0o700 }); mkdirSync(workspace);
  const configPath = join(home, '.dgc/config.json'), marker = join(directory, 'unexpected-network');
  const original = JSON.stringify({ model: 'fixture', base_url: 'http://127.0.0.1:1/v1', pips_enabled: true,
    sandbox: false, mcp_servers: {}, hooks: {}, artifact_autostart: false, notify: 'off', suggest: false });
  writeFileSync(configPath, original, { mode: 0o600 });
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const python = process.env.DGC_SDK_TEST_PYTHON || 'python3';
  const bootstrap = `import sys; sys.path.insert(0, ${JSON.stringify(root)})\nimport socket\ndef refuse(*args, **kwargs):\n from pathlib import Path\n Path(${JSON.stringify(marker)}).write_text('unexpected network')\n raise AssertionError('network forbidden')\nsocket.socket.connect = refuse\nsocket.create_connection = refuse\nfrom dgc.cli import main\nsys.argv = ['dgc','serve']\nmain()\n`;
  const dgc = new DGC({ runtime: [python, '-c', bootstrap], inheritUserState: true,
    sandbox: 'off', extraEnv: { DGC_HOME: home } });
  try {
    const session = await dgc.session({ cwd: workspace });
    assert.equal(session.capabilities.session_policy.digest, '');
    const value = await session.pips.read('list_workspaces', {});
    assert.ok(Array.isArray(value.workspaces));
    assert.equal(value.workspaces.length, 2);
    assert.equal(value.workspaces.filter(w => w.kind === 'personal').length, 1);
    assert.equal((await session.pips.read('list_workspace_overviews', {})).total_workspaces, 2);
    assert.deepEqual((await session.pips.read('list_pending_pip_reviews', {})).reviews, []);
    assert.ok(Array.isArray((await session.pips.read('list_recent_workspace_activity', { limit: 20 })).events));
    assert.equal((await session.pips.read('get_pip_runner', {})).runner.online, false);
    await session.close();
    assert.equal(readFileSync(configPath, 'utf8'), original);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(home, '.dgc/pips/runs')), false);
  } finally { await dgc.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('API10 aggregate and adaptation reads preserve additive capability gates', async () => {
  for (const command of ['get_pip_proposal', 'list_workspace_overviews', 'list_pending_pip_reviews', 'list_recent_workspace_activity', 'list_pip_adaptations']) {
    const old = fixture({ ...caps, pips_api_version: 9 });
    await assert.rejects(old.session.pips.read(command, {}), DGCUnsupportedError);
    assert.equal(old.calls.length, 0);
    const current = fixture({ ...caps, pips_api_version: 10 });
    const values = command === 'get_pip_proposal' ? { pip_id: 'pip_a', proposal_id: 'proposal_a' } : command === 'list_pip_adaptations' ? { pip_id: 'pip_a' } : { limit: 20 };
    const result = await current.session.pips.read(command, values);
    assert.equal(result.request.type, command);
    assert.deepEqual(Object.keys(current.calls[0].payload), ['type', 'request']);
    await assert.rejects(current.session.pips.mutate(command, values, { approved: true }), DGCConfigError);
  }
});

test('API11 source policy proposals require explicit advertisement', async () => {
  const params = { pip_id: 'pip_a', expected_version: 1, reason: 'Review source',
    changes: { source_policy: { mode: 'current_tree', exclusions: 'safe_source_v1' }, schedule: null, event_trigger: null } };
  for (const version of [8, 9, 10]) {
    const old = fixture({ ...caps, pips_api_version: version });
    await assert.rejects(old.session.pips.mutate('propose_pip_update', params, { approved: true }), DGCUnsupportedError);
    assert.equal(old.calls.length, 0);
  }
  const current = fixture({ ...caps, pips_api_version: 11 });
  const result = await current.session.pips.mutate('propose_pip_update', params, { approved: true });
  assert.deepEqual(result.request.changes, params.changes);
  const legacy = fixture(caps);
  assert.deepEqual((await legacy.session.pips.mutate('propose_pip_update', { ...params, changes: { name: 'Reviewed label' } }, { approved: true })).request.changes, { name: 'Reviewed label' });
});


test('API16 archive/restore require reviewed lifecycle pins and approval on every retry', async () => {
  const params = { pip_id: 'pip_a', expected_version: 2, expected_lifecycle_revision: 3,
    request_key: 'review-once', reason: 'Reviewed lifecycle change' };
  for (const command of ['archive_pip', 'restore_pip']) {
    const old = fixture({ ...caps, pips_api_version: 15 });
    await assert.rejects(old.session.pips.mutate(command, params, { approved: true }), DGCUnsupportedError);
    assert.equal(old.calls.length, 0);
    const current = fixture({ ...caps, pips_api_version: 16 });
    for (let i = 0; i < 2; i++) {
      await assert.rejects(current.session.pips.read(command, params), DGCConfigError);
      await assert.rejects(current.session.pips.mutate(command, params), DGCConfigError);
      const result = await current.session.pips.mutate(command, params, { approved: true });
      for (const key of Object.keys(params)) assert.equal(result.request[key], params[key]);
    }
    for (const field of ['actor', 'archived', 'workspace_id', 'permissions', 'project_root']) {
      await assert.rejects(current.session.pips.mutate(command, { ...params, [field]: 'forged' }, { approved: true }), DGCConfigError);
    }
    assert.equal(current.calls.length, 2);
  }
});


test('API16 lifecycle pins preserve legacy pause/resume but cannot be silently dropped', async () => {
  for (const command of ['pause_pip', 'resume_pip']) {
    const legacy = fixture(caps);
    await legacy.session.pips.mutate(command, { pip_id: 'pip_a' }, { approved: true });
    await assert.rejects(legacy.session.pips.mutate(command,
      { pip_id: 'pip_a', expected_lifecycle_revision: 3 }, { approved: true }), DGCUnsupportedError);
    assert.equal(legacy.calls.length, 1);
    const current = fixture({ ...caps, pips_api_version: 16 });
    const result = await current.session.pips.mutate(command,
      { pip_id: 'pip_a', expected_lifecycle_revision: 3 }, { approved: true });
    assert.equal(result.request.expected_lifecycle_revision, 3);
  }
});


// API19 reviewed statements, with no provider or storage calls.
const reads = {
  get_pip_statement_anchor: { pip_id: 'pip_a', source_run_id: 'run_a' },
  list_pip_statements: { pip_id: 'pip_a', before_id: 4, limit: 20 },
};
const writes = {
  record_pip_statement: { pip_id: 'pip_a', kind: 'fact', title: 'Maintainer claim', statement: 'An authored claim, not evidence.',
    reason: 'Reviewed explicitly', expires_at: null, expected_anchor_digest: 'a'.repeat(64), request_key: 'once', source_run_id: 'run_a' },
  revoke_pip_statement: { pip_id: 'pip_a', memory_id: 'memory_a', expected_revision: 0, reason: 'Revisit' },
};
function statementFixture({ version = 19, enabled = true, restricted = false, isolated = false, plan = false, transform = value => value } = {}) {
  const calls = [];
  const pips = new Pips({ pips_supported: true, pips_enabled: enabled, pips_api_version: version }, restricted, plan,
    async (payload, response, requestId) => {
      calls.push({ payload, response, requestId });
      return transform({ request_id: requestId, command: payload.request.type, ok: true, result: { request: payload.request } });
    }, isolated);
  return { pips, calls };
}
test('API19 gates all four statement controls, leaving API18 transport untouched', async () => {
  for (const options of [{ version: 18 }, { version: '19' }, { enabled: false }]) {
    const current = statementFixture(options);
    for (const [command, params] of Object.entries({ ...reads, ...writes })) {
      await assert.rejects(Object.hasOwn(reads, command) ? current.pips.read(command, params)
        : current.pips.mutate(command, params, { approved: true }), DGCUnsupportedError);
    }
    assert.equal(current.calls.length, 0);
  }
});
test('typed statement reads and separately approved writes retain exact authored fields and pins', async () => {
  const current = statementFixture();
  for (const [command, params] of Object.entries({ ...reads, ...writes })) {
    const original = structuredClone(params);
    if (Object.hasOwn(reads, command)) {
      await assert.rejects(current.pips.mutate(command, params, { approved: true }), DGCConfigError);
      await current.pips.read(command, params);
    } else {
      await assert.rejects(current.pips.read(command, params), DGCConfigError);
      for (const approved of [false, null, 1, 'true']) await assert.rejects(current.pips.mutate(command, params, { approved }), DGCConfigError);
      await current.pips.mutate(command, params, { approved: true });
      await assert.rejects(current.pips.mutate(command, params), DGCConfigError);
    }
    const request = current.calls.at(-1).payload.request;
    for (const key of Object.keys(params)) assert.deepEqual(request[key], original[key]);
    assert.deepEqual(params, original);
  }
  assert.equal(current.calls.length, 4);
  const { source_run_id: ignored, ...noSource } = writes.record_pip_statement;
  const result = await current.pips.mutate('record_pip_statement', { ...noSource, kind: 'preference' }, { approved: true });
  assert.equal(result.request.expires_at, null); assert.equal(Object.hasOwn(result.request, 'source_run_id'), false);
});
test('review approval does not bypass inherited state, policy, sandbox or plan restrictions', async () => {
  for (const options of [{ isolated: true }, { restricted: true }]) {
    const current = statementFixture(options);
    for (const [command, params] of Object.entries({ ...reads, ...writes })) {
      await assert.rejects(Object.hasOwn(reads, command) ? current.pips.read(command, params)
        : current.pips.mutate(command, params, { approved: true }), DGCUnsupportedError);
    }
    assert.equal(current.calls.length, 0);
  }
  const planned = statementFixture({ plan: true });
  await planned.pips.read('get_pip_statement_anchor', reads.get_pip_statement_anchor);
  for (const [command, params] of Object.entries(writes)) await assert.rejects(planned.pips.mutate(command, params, { approved: true }), DGCUnsupportedError);
  assert.equal(planned.calls.length, 1);
});
test('statement controls do not accept actor/scope/permission or correlation injection', async () => {
  const current = statementFixture();
  for (const [command, params] of Object.entries({ ...reads, ...writes })) {
    for (const key of ['actor', 'workspace_id', 'project_root', 'verification', 'classification', 'permissions', 'request_id']) {
      const forged = { ...params, [key]: 'forged' };
      await assert.rejects(Object.hasOwn(reads, command) ? current.pips.read(command, forged)
        : current.pips.mutate(command, forged, { approved: true }), DGCConfigError);
    }
  }
  for (const statement of ['\ud800', '界'.repeat(12000)]) await assert.rejects(current.pips.mutate('record_pip_statement',
    { ...writes.record_pip_statement, statement }, { approved: true }), DGCConfigError);
  assert.equal(current.calls.length, 0);
});
test('backend statement conflicts propagate without retry or invented verification', async () => {
  const current = statementFixture({ transform: value => ({ ...value, ok: false, error: { code: 'conflict', message: 'Review a fresh anchor.' } }) });
  await assert.rejects(current.pips.mutate('record_pip_statement', writes.record_pip_statement, { approved: true }), error => {
    assert.ok(error instanceof DGCCommandRejectedError); assert.equal(error.reason, 'conflict'); return true;
  });
  assert.equal(current.calls.length, 1);
});

test('API20 Quill capability does not blanket-gate API19 audit schedules and events', async () => {
  const old = fixture({ ...caps, pips_api_version: 19 });
  const variants = [
    { schedule: { type: 'interval', minutes: 30 } },
    { schedule: { type: 'daily', time: '09:00', timezone: 'UTC' } },
    { schedule: { type: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' } },
    { schedule: { type: 'once', at: '2026-10-03T12:00:00.000Z' } },
    { schedule: null, event_trigger: { events: ['session_turn_completed'], minimum_minutes: 30 } },
    { schedule: null, event_trigger: null },
  ];
  for (const changes of variants) {
    const params = { pip_id: 'pip_audit', expected_version: 7, reason: 'Human reviewed automation', changes };
    const original = structuredClone(params);
    const result = await old.session.pips.mutate('propose_pip_update', params, { approved: true });
    for (const key of Object.keys(params)) assert.deepEqual(result.request[key], original[key]);
    assert.deepEqual(params, original);
  }
  assert.equal(old.calls.length, variants.length);
  assert.ok(old.calls.every(call => call.payload.request.type === 'propose_pip_update'));
});

test('old Quill backend refusal remains structured without hidden lookup, downgrade or retry', async () => {
  for (const [code, changes] of [
    ['manual_only', { schedule: { type: 'interval', minutes: 30 } }],
    ['invalid_event_trigger', { event_trigger: { events: ['context_updated'], minimum_minutes: 30 } }],
  ]) {
    const old = fixture({ ...caps, pips_api_version: 19 });
    const send = old.wire.request;
    old.wire.request = async (...args) => ({ ...await send(...args), ok: false,
      error: { code, message: 'This runtime cannot automate Quill.' } });
    const params = { pip_id: 'pip_quill', expected_version: 7, reason: 'Reviewed choice', changes };
    await assert.rejects(old.session.pips.mutate('propose_pip_update', params, { approved: true }), error => {
      assert.ok(error instanceof DGCCommandRejectedError);
      assert.equal(error.reason, code); assert.equal(error.command, 'propose_pip_update'); return true;
    });
    assert.equal(old.calls.length, 1);
    assert.deepEqual(old.calls[0].payload.request.changes, changes);
    assert.equal(old.calls[0].payload.request.expected_version, 7);
  }
});

test('API20 Quill proposal and acceptance keep separate approval and exact existing wire fields', async () => {
  const current = fixture({ ...caps, pips_api_version: 20 });
  const params = { pip_id: 'pip_quill', expected_version: 7, reason: 'Human reviewed automation',
    changes: { schedule: { type: 'interval', minutes: 30 } } };
  const accept = { pip_id: 'pip_quill', proposal_id: 'proposal_saved', expected_version: 7 };
  for (const [command, values] of [['propose_pip_update', params], ['accept_pip_update', accept]]) {
    for (const approved of [false, 1, 'true', null]) {
      await assert.rejects(current.session.pips.mutate(command, values, { approved }), DGCConfigError);
    }
    await current.session.pips.mutate(command, values, { approved: true });
  }
  assert.deepEqual(current.calls.map(call => call.payload.request.type), ['propose_pip_update', 'accept_pip_update']);
  assert.deepEqual([...COMMAND_FIELDS.propose_pip_update].sort(), ['changes', 'expected_version', 'pip_id', 'reason']);
  for (const field of ['pip_type', 'minimum_api_version', 'actor', 'permissions']) {
    await assert.rejects(current.session.pips.mutate('propose_pip_update', { ...params, [field]: 'forged' }, { approved: true }), DGCConfigError);
  }
  assert.equal(current.calls.length, 2);
});

test('API20 cannot refresh stale review versions or override existing control restrictions', async () => {
  const params = { pip_id: 'pip_quill', expected_version: 2, reason: 'Reviewed event choice',
    changes: { event_trigger: { events: ['commit_changed'], minimum_minutes: 30 } } };
  const stale = fixture({ ...caps, pips_api_version: 20 });
  const send = stale.wire.request;
  stale.wire.request = async (...args) => ({ ...await send(...args), ok: false,
    error: { code: 'conflict', message: 'Review the current job.' } });
  await assert.rejects(stale.session.pips.mutate('propose_pip_update', params, { approved: true }), error => {
    assert.ok(error instanceof DGCCommandRejectedError); assert.equal(error.reason, 'conflict'); return true;
  });
  assert.equal(stale.calls.length, 1); assert.equal(stale.calls[0].payload.request.expected_version, 2);
  for (const changes of [{ isolated: true }, { policy: {} }, { permissionMode: 'plan' },
    { sandbox: { requirement: 'required', active: false } }, { sandbox: { requirement: 'off', active: true } }]) {
    const restricted = fixture({ ...caps, pips_api_version: 20 }, changes);
    await assert.rejects(restricted.session.pips.mutate('propose_pip_update', params, { approved: true }), DGCUnsupportedError);
    assert.equal(restricted.calls.length, 0);
  }
});

test('API29 connected-account discovery is explicit and read-only', async()=>{
 const old=fixture({...caps,pips_api_version:28});await assert.rejects(old.session.pips.read('list_pip_accounts',{server:'composio'}),/API 29/);assert.equal(old.calls.length,0);
 const current=fixture({...caps,pips_api_version:29});await assert.rejects(current.session.pips.mutate('list_pip_accounts',{server:'composio'},{approved:true}),/classified/);
 const result=await current.session.pips.read('list_pip_accounts',{server:'composio'});assert.equal(result.request.type,'list_pip_accounts');assert.equal(current.calls.length,1);
});

test('API30 Personal result handoff is a proposal mutation, never implicit dispatch',async()=>{
 const command='propose_pip_personal_handoff',params={source_run_id:'run_source',target_pip_id:'pip_target',shared_text:'Reviewed result.',task:'Create a checklist',idempotency_key:'one'};
 const old=fixture({...caps,pips_api_version:29});await assert.rejects(old.session.pips.mutate(command,params,{approved:true}),/API 30/);assert.equal(old.calls.length,0);
 const current=fixture({...caps,pips_api_version:30});await assert.rejects(current.session.pips.read(command,params),DGCConfigError);await assert.rejects(current.session.pips.mutate(command,params),DGCConfigError);await assert.rejects(current.session.pips.mutate(command,{...params,action:{kind:'patch'}},{approved:true}),DGCConfigError);assert.equal(current.calls.length,0);
 assert.equal((await current.session.pips.mutate(command,params,{approved:true})).request.shared_text,params.shared_text);assert.equal(current.calls.length,1);
});

test('API31 message reviews require approval and cannot acquire hidden authority fields',async()=>{
 const args={action_id:'appaction_test',expected_digest:'a'.repeat(64)};
 for(const name of ['accept_pip_app_action','reject_pip_app_action']){
  const old=fixture({...caps,pips_api_version:30});await assert.rejects(old.session.pips.mutate(name,args,{approved:true}),/API 31/);assert.equal(old.calls.length,0);
  const current=fixture({...caps,pips_api_version:31});await assert.rejects(current.session.pips.read(name,args),DGCConfigError);await assert.rejects(current.session.pips.mutate(name,args),DGCConfigError);await assert.rejects(current.session.pips.mutate(name,{...args,actor:'model'},{approved:true}),DGCConfigError);assert.equal(current.calls.length,0);assert.equal((await current.session.pips.mutate(name,args,{approved:true})).request.expected_digest,args.expected_digest);
 }
 const current=fixture({...caps,pips_api_version:31});for(const [name,args] of [['inspect_pip_send_connection',{server:'composio'}],['get_pip_app_action',{action_id:'appaction_test'}],['list_pip_app_actions',{pip_id:'pip_test'}]])assert.equal((await current.session.pips.read(name,args)).request.type,name);
});

test('API32 inert email drafts require current runtime and preparation is a separate mutation',async()=>{
 const old=fixture({...caps,pips_api_version:31});await assert.rejects(old.session.pips.read('get_pip_message_draft',{draft_id:'maildraft_test'}),/API 32/);assert.equal(old.calls.length,0);
 const current=fixture({...caps,pips_api_version:32});assert.equal((await current.session.pips.read('list_pip_message_drafts',{pip_id:'pip_test'})).request.type,'list_pip_message_drafts');const args={draft_id:'maildraft_test',expected_digest:'a'.repeat(64)};await assert.rejects(current.session.pips.mutate('dismiss_pip_message_draft',args),DGCConfigError);assert.equal((await current.session.pips.mutate('dismiss_pip_message_draft',args,{approved:true})).request.draft_id,args.draft_id);
});
test('API33 recurring calendar grants are reviewed and refused by older runtimes',async()=>{
 const params={pip_id:'pip_saved',expected_version:1,changes:{app_plan:{schema_version:2}},reason:'Reviewed daily read'};
 const old=fixture({...caps,pips_api_version:32});await assert.rejects(old.session.pips.mutate('propose_pip_update',params,{approved:true}),/API 33/);assert.equal(old.calls.length,0);
 const current=fixture({...caps,pips_api_version:33});await assert.rejects(current.session.pips.mutate('propose_pip_update',params),DGCConfigError);assert.deepEqual((await current.session.pips.mutate('propose_pip_update',params,{approved:true})).request.changes,params.changes);
});

test('API34 calendar creation is a separately approved preparation with closed fields',async()=>{
 const args={source_run_id:'run_test',server:'composio',connection_digest:'a'.repeat(64),account:'ca_test',schema_digest:'b'.repeat(64),event:{summary:'Read',description:'A chapter',start_datetime:'2026-12-01T11:00:00Z',end_datetime:'2026-12-01T11:30:00Z',timezone:'UTC'},request_key:'calendar'};
 const old=fixture({...caps,pips_api_version:33});await assert.rejects(old.session.pips.read('inspect_pip_calendar_connection',{server:'composio'}),/API 34/);await assert.rejects(old.session.pips.mutate('propose_pip_calendar_action',args,{approved:true}),/API 34/);assert.equal(old.calls.length,0);
 const current=fixture({...caps,pips_api_version:34});await assert.rejects(current.session.pips.mutate('propose_pip_calendar_action',args),DGCConfigError);await assert.rejects(current.session.pips.mutate('propose_pip_calendar_action',{...args,actor:'model'},{approved:true}),DGCConfigError);
 assert.equal((await current.session.pips.read('inspect_pip_calendar_connection',{server:'composio'})).request.type,'inspect_pip_calendar_connection');assert.deepEqual((await current.session.pips.mutate('propose_pip_calendar_action',args,{approved:true})).request.event,args.event);
});

test('API35 calendar drafts are read-only until separate explicit preparation',async()=>{
 const old=fixture({...caps,pips_api_version:34});await assert.rejects(old.session.pips.read('get_pip_calendar_draft',{draft_id:'caldraft_test'}),/API 35/);assert.equal(old.calls.length,0);
 const current=fixture({...caps,pips_api_version:35});assert.equal((await current.session.pips.read('list_pip_calendar_drafts',{pip_id:'pip_test'})).request.type,'list_pip_calendar_drafts');
 const args={draft_id:'caldraft_test',expected_digest:'a'.repeat(64),server:'composio',connection_digest:'b'.repeat(64),account:'ca_test',schema_digest:'c'.repeat(64),event:{summary:'Reading',description:'A chapter',start_datetime:'2026-12-01T11:00:00Z',end_datetime:'2026-12-01T11:30:00Z',timezone:'UTC'}};
 await assert.rejects(current.session.pips.mutate('prepare_pip_calendar_draft',args),DGCConfigError);await assert.rejects(current.session.pips.mutate('prepare_pip_calendar_draft',{...args,approve:true},{approved:true}),DGCConfigError);
 assert.deepEqual((await current.session.pips.mutate('prepare_pip_calendar_draft',args,{approved:true})).request.event,args.event);
});

test('API36 connector calls require explicit approval and reject account smuggling',async()=>{
 const args={source_run_id:'run_saved',server:'make',connection_digest:'a'.repeat(64),schema_digest:'b'.repeat(64),call:{tool:'run_workflow',arguments:{workflow_id:'123'}},request_key:'one'};
 const old=fixture({...caps,pips_api_version:35});await assert.rejects(old.session.pips.read('inspect_pip_connector_actions',{server:'make'}),/API 36/);await assert.rejects(old.session.pips.mutate('propose_pip_connector_action',args,{approved:true}),/API 36/);assert.equal(old.calls.length,0);
 const current=fixture({...caps,pips_api_version:36});await assert.rejects(current.session.pips.mutate('propose_pip_connector_action',args),DGCConfigError);await assert.rejects(current.session.pips.mutate('propose_pip_connector_action',{...args,account:'ca_extra'},{approved:true}),DGCConfigError);assert.equal(current.calls.length,0);
 assert.equal((await current.session.pips.read('inspect_pip_connector_actions',{server:'make'})).request.type,'inspect_pip_connector_actions');assert.deepEqual((await current.session.pips.mutate('propose_pip_connector_action',args,{approved:true})).request.call,args.call);
});

test('API37 connector drafts need explicit preparation and cannot smuggle execute authority',async()=>{
 const old=fixture({...caps,pips_api_version:36});await assert.rejects(old.session.pips.read('get_pip_connector_draft',{draft_id:'conndraft_test'}),/API 37/);assert.equal(old.calls.length,0);
 const current=fixture({...caps,pips_api_version:37});assert.equal((await current.session.pips.read('list_pip_connector_drafts',{pip_id:'pip_test'})).request.type,'list_pip_connector_drafts');
 const args={draft_id:'conndraft_test',expected_digest:'a'.repeat(64),call:{tool:'run_workflow',arguments:{workflow_id:'123'}}};
 await assert.rejects(current.session.pips.mutate('prepare_pip_connector_draft',args),DGCConfigError);await assert.rejects(current.session.pips.mutate('prepare_pip_connector_draft',{...args,execute:true},{approved:true}),DGCConfigError);
 assert.deepEqual((await current.session.pips.mutate('prepare_pip_connector_draft',args,{approved:true})).request.call,args.call);
});

test('API38 calendar guests and series reject old runtime without dispatch',async()=>{
 const event={summary:'Reading',description:'One chapter',start_datetime:'2099-12-01T11:00:00Z',end_datetime:'2099-12-01T11:30:00Z',timezone:'UTC',attendees:['friend@example.invalid'],repeat:{frequency:'weekly',interval:1,count:4},send_invitations:true};
 const args={source_run_id:'run_test',server:'composio',connection_digest:'a'.repeat(64),account:'ca_test',schema_digest:'b'.repeat(64),event,request_key:'series'};
 const old=fixture({...caps,pips_api_version:37});await assert.rejects(old.session.pips.mutate('propose_pip_calendar_action',args,{approved:true}),/API 38/);assert.equal(old.calls.length,0);
 const current=fixture({...caps,pips_api_version:38});await assert.rejects(current.session.pips.mutate('propose_pip_calendar_action',args),/approved/);assert.deepEqual((await current.session.pips.mutate('propose_pip_calendar_action',args,{approved:true})).request.event,event);
});

test('API41 GitHub reads gate before transport and still need the host approval', async () => {
  const github_plan = { schema_version: 1, repository: 'OpenPeach-ai/dgc', reads: [{ kind: 'commit_checks' }] };
  const params = { pip_id: 'pip_saved', expected_version: 1, reason: 'Human review', changes: { github_plan } };
  const old = fixture({ ...caps, pips_api_version: 40 });
  await assert.rejects(old.session.pips.mutate('propose_pip_update', params, { approved: true }), /API 41/);
  assert.equal(old.calls.length, 0);
  const current = fixture({ ...caps, pips_api_version: 41 });
  await assert.rejects(current.session.pips.mutate('propose_pip_update', params), DGCConfigError);
  await current.session.pips.mutate('propose_pip_update', params, { approved: true });
  assert.deepEqual(current.calls[0].payload.request.changes, { github_plan });
});

test('API41 digest and notification settings are local reads and approved mutations', async () => {
  const old = fixture({ ...caps, pips_api_version: 40 });
  await assert.rejects(old.session.pips.read('get_pip_digest', {}), /API 41/);
  assert.equal(old.calls.length, 0);
  const current = fixture({ ...caps, pips_api_version: 41 });
  await current.session.pips.read('get_pip_digest', {});
  const settings = { pip_id: 'pip_saved', min_severity: 'high', alert_severity: null, expected_revision: 0 };
  await assert.rejects(current.session.pips.mutate('set_pip_notify_settings', settings), DGCConfigError);
  await current.session.pips.mutate('set_pip_notify_settings', settings, { approved: true });
  assert.deepEqual(current.calls.map((c) => c.payload.request.type), ['get_pip_digest', 'set_pip_notify_settings']);
});
