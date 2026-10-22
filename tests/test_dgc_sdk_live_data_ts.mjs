/** Pips API 60 in the TypeScript SDK: a live-data Pip's approved read-only commands (changes.live_plan). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError } from '../sdk/typescript/src/index.ts';

const caps = { pips_supported: true, pips_api_version: 60, pips_enabled: true };
const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
function fixture(capabilities = caps) {
  const calls = [];
  const wire = { request: async (payload, response, opts) => {
    calls.push({ payload, response, opts });
    return { type: 'pips_result', request_id: opts.requestId, command: payload.request.type, ok: true, result: { request: payload.request } };
  } };
  return { calls, session: new Session(wire, { capabilities }, init) };
}
const live_plan = { schema_version: 1, commands: ['sqlite3 -readonly data/app.db "SELECT count(*) FROM orders"', 'df -h .'] };
const params = (plan = live_plan) => ({ pip_id: 'pip_saved', expected_version: 1, reason: 'Watch the orders', changes: { live_plan: plan } });

test('changes.live_plan is refused before Pips API 60, before anything is sent', async () => {
  const old = fixture({ ...caps, pips_api_version: 59 });
  await assert.rejects(old.session.pips.mutate('propose_pip_update', params(), { approved: true }), /API 60/);
  assert.equal(old.calls.length, 0);
});

test('from API 60 the exact commands are sent, removal too; a malformed list is refused here', async () => {
  const current = fixture();
  await current.session.pips.mutate('propose_pip_update', params(), { approved: true });
  assert.deepEqual(current.calls[0].payload.request.changes, { live_plan });
  await current.session.pips.mutate('propose_pip_update', params(null), { approved: true });
  assert.deepEqual(current.calls[1].payload.request.changes, { live_plan: null });
  for (const bad of [{ schema_version: 1, commands: [] }, { schema_version: 1, commands: ['df', 'df'] },
    { schema_version: 1, commands: ['df\nrm -rf /'] }, { schema_version: 2, commands: ['df'] },
    { schema_version: 1, commands: ['df'], ports: [80] }]) {
    await assert.rejects(current.session.pips.mutate('propose_pip_update', params(bad), { approved: true }), DGCConfigError);
  }
  assert.equal(current.calls.length, 2);
});
