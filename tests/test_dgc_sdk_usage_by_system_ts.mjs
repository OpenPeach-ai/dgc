/** Token usage by system in the TypeScript SDK: getUsage(range, system) sends `system` only to a CLI that offers
 *  capabilities.usage_by_system, and never to an older one. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';

const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };

function fixture(capabilities) {
  const calls = [];
  const wire = { request: async (payload, response) => {
    calls.push(payload);
    assert.equal(response, 'usage_report');
    return { type: 'usage_report', request_id: payload.request_id, range: payload.range, generated_at: '',
      totals: {}, by_model: [], by_day: [] };
  } };
  return { calls, session: new Session(wire, { capabilities }, init) };
}

test('getUsage with a system sends it to a CLI that offers usage by system', async () => {
  const { calls, session } = fixture({ usage_ledger: true, usage_by_system: true });
  await session.getUsage('7d', 'nas');
  await session.getUsage('today');
  assert.equal(calls[0].system, 'nas');
  assert.equal(calls[0].range, '7d');
  assert.ok(!('system' in calls[1]), 'no system, no field: what every CLI already accepts');
});

test('an older CLI is never sent the field', async () => {
  const { calls, session } = fixture({ usage_ledger: true });
  await assert.rejects(session.getUsage('7d', 'nas'), DGCUnsupportedError);
  assert.equal(calls.length, 0);
  await session.getUsage('7d');
  assert.equal(calls.length, 1);
});
