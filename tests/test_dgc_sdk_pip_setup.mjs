/** API23 setup controls: offline transport, exact review pins, no timers/network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError, DGCProtocolError, DGCCommandRejectedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const caps = { pips_supported: true, pips_api_version: 23, pips_enabled: true };
const reads = { list_pip_setups: { workspace_id: 'ws_local' }, get_pip_setup: { setup_id: 'setup_saved' } };
const writes = Object.fromEntries(['accept_pip_setup', 'reject_pip_setup'].map(command =>
  [command, { setup_id: 'setup_saved', expected_digest: 'a'.repeat(64) }]));
const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
function fixture(capabilities = caps, changes = {}) {
  const calls = [];
  const wire = { transform: event => event, request: async (payload, response, opts) => {
    calls.push({ payload, response, opts });
    const request = payload.request;
    return wire.transform({ type: 'pips_result', request_id: opts.requestId, command: request.type, ok: true, result: { request } });
  } };
  return { calls, wire, session: new Session(wire, { capabilities }, { ...init, ...changes }) };
}

test('API23 four setup commands have exact runtime fields', () => {
  for (const [command, params] of Object.entries({ ...reads, ...writes })) {
    assert.deepEqual([...COMMAND_FIELDS[command]].sort(), Object.keys(params).sort());
  }
});

test('API25 model revisions are exact human-approved mutations and keep review digest', async () => {
  const params = { setup_id: 'setup_saved', expected_digest: 'a'.repeat(64),
    model_choice: { mode: 'model', model: 'review-model' } };
  assert.deepEqual([...COMMAND_FIELDS.revise_pip_setup].sort(), Object.keys(params).sort());
  const old = fixture({ ...caps, pips_api_version: 24 });
  await assert.rejects(old.session.pips.mutate('revise_pip_setup', params, { approved: true }), /API 25/);
  assert.equal(old.calls.length, 0);
  const current = fixture({ ...caps, pips_api_version: 25 });
  await assert.rejects(current.session.pips.read('revise_pip_setup', params), DGCConfigError);
  await assert.rejects(current.session.pips.mutate('revise_pip_setup', params), DGCConfigError);
  for (const field of ['actor', 'workspace_id', 'run_now', 'schedule', 'body']) {
    await assert.rejects(current.session.pips.mutate('revise_pip_setup', { ...params, [field]: 'forged' }, { approved: true }), DGCConfigError);
  }
  assert.equal(current.calls.length, 0);
  const result = await current.session.pips.mutate('revise_pip_setup', params, { approved: true });
  assert.deepEqual(result.request.model_choice, params.model_choice);
  assert.equal(result.request.expected_digest, params.expected_digest);
  assert.equal(current.calls.length, 1);
});

test('API22 or invalid and disabled capabilities refuse setup before transport', async () => {
  for (const capabilities of [{ ...caps, pips_api_version: 22 }, { ...caps, pips_api_version: '23' },
    { ...caps, pips_api_version: true }, { ...caps, pips_enabled: false }, { ...caps, pips_supported: false }]) {
    const current = fixture(capabilities);
    for (const [command, params] of Object.entries({ ...reads, ...writes })) {
      await assert.rejects(command in reads ? current.session.pips.read(command, params)
        : current.session.pips.mutate(command, params, { approved: true }), DGCUnsupportedError);
    }
    assert.equal(current.calls.length, 0);
  }
});

test('read and human review are distinct; each acceptance/rejection needs explicit approval', async () => {
  const current = fixture();
  for (const [command, params] of Object.entries({ ...reads, ...writes })) {
    const before = structuredClone(params); let result;
    if (command in reads) {
      await assert.rejects(current.session.pips.mutate(command, params, { approved: true }), DGCConfigError);
      result = await current.session.pips.read(command, params);
    } else {
      await assert.rejects(current.session.pips.read(command, params), DGCConfigError);
      for (const approved of [false, null, 1, 'true']) {
        await assert.rejects(current.session.pips.mutate(command, params, { approved }), DGCConfigError);
      }
      result = await current.session.pips.mutate(command, params, { approved: true });
      await assert.rejects(current.session.pips.mutate(command, params), DGCConfigError);
    }
    for (const key of Object.keys(params)) assert.deepEqual(result.request[key], before[key]);
    assert.deepEqual(params, before);
  }
  assert.equal(current.calls.length, 4);
});

test('setup SDK cannot inject actor, scope, execution, schedule or replacement body', async () => {
  const current = fixture();
  for (const [command, params] of Object.entries({ ...reads, ...writes })) {
    for (const field of ['actor', 'project_root', 'target_root', 'run_now', 'schedule', 'permissions', 'request_id', 'body',
      ...(command === 'list_pip_setups' ? [] : ['workspace_id'])]) {
      const injected = { ...params, [field]: 'forged' };
      await assert.rejects(command in reads ? current.session.pips.read(command, injected)
        : current.session.pips.mutate(command, injected, { approved: true }), DGCConfigError);
    }
  }
  await assert.rejects(current.session.pips.mutate('propose_pip_setup', {}, { approved: true }), DGCConfigError);
  assert.equal(current.calls.length, 0);
});

test('approval never overrides isolation, policy, sandbox or plan mode', async () => {
  for (const changes of [{ isolated: true }, { policy: {} }, { sandbox: { requirement: 'required', active: false } },
    { sandbox: { requirement: 'preferred', active: false } }, { sandbox: { requirement: 'off', active: true } }]) {
    const current = fixture(caps, changes);
    for (const [command, params] of Object.entries({ ...reads, ...writes })) {
      await assert.rejects(command in reads ? current.session.pips.read(command, params)
        : current.session.pips.mutate(command, params, { approved: true }), DGCUnsupportedError);
    }
    assert.equal(current.calls.length, 0);
  }
  const planned = fixture(caps, { permissionMode: 'plan' });
  await planned.session.pips.read('get_pip_setup', reads.get_pip_setup);
  for (const [command, params] of Object.entries(writes)) {
    await assert.rejects(planned.session.pips.mutate(command, params, { approved: true }), DGCUnsupportedError);
  }
  assert.equal(planned.calls.length, 1);
});

test('backend stale-review refusal is never retried, rebased or converted to acceptance', async () => {
  const current = fixture();
  current.wire.transform = event => ({ ...event, ok: false, error: { code: 'review_changed', message: 'Read the exact setup again.' } });
  await assert.rejects(current.session.pips.mutate('accept_pip_setup', writes.accept_pip_setup, { approved: true }),
    error => error instanceof DGCCommandRejectedError && error.reason === 'review_changed');
  assert.equal(current.calls.length, 1);
  assert.equal(current.calls[0].payload.request.expected_digest, 'a'.repeat(64));
  assert.equal(current.calls[0].payload.request.type, 'accept_pip_setup');
});

test('setup response command and nested correlation must agree', async () => {
  for (const changes of [{ command: 'get_pip' }, { request_id: 'another-request' }, { ok: 1 }]) {
    const current = fixture(); current.wire.transform = event => ({ ...event, ...changes });
    await assert.rejects(current.session.pips.read('get_pip_setup', reads.get_pip_setup), DGCProtocolError);
    assert.equal(current.calls.length, 1);
  }
});

test('API28 shared connector inspection is gated and never an approved mutation', async () => {
  for (const [command, params] of Object.entries({list_pip_connections:{},inspect_pip_connection:{server:'composio'}})) {
    const old=fixture({...caps,pips_api_version:27});
    await assert.rejects(old.session.pips.read(command,params), /API 28/);
    assert.equal(old.calls.length,0);
    const current=fixture({...caps,pips_api_version:28});
    await assert.rejects(current.session.pips.mutate(command,params,{approved:true}), DGCConfigError);
    await assert.rejects(current.session.pips.read(command,{...params,token:'forged'}), DGCConfigError);
    assert.equal(current.calls.length,0);
    assert.equal((await current.session.pips.read(command,params)).request.type,command);
  }
});

test('API28 app grant mutations refuse old runtime and still need individual approval', async () => {
  const params={pip_id:'pip_saved',expected_version:1,changes:{app_plan:null},reason:'Remove reads'};
  const old=fixture({...caps,pips_api_version:27});
  await assert.rejects(old.session.pips.mutate('propose_pip_update',params,{approved:true}), /API 28/);
  assert.equal(old.calls.length,0);
  const current=fixture({...caps,pips_api_version:28});
  await assert.rejects(current.session.pips.mutate('propose_pip_update',params),DGCConfigError);
  assert.deepEqual((await current.session.pips.mutate('propose_pip_update',params,{approved:true})).request.changes, {app_plan:null});
});
