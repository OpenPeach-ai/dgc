/** Pips API 75 in the TypeScript SDK: paying by itself, a rule per Pip (set_pip_paying, ask or allow) and the day's count
 *  (get_pips_payments / set_pips_payments {limit}): known, checked, refused before API 75, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

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

test('paying by itself: refused before API 75, checked, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.get_pips_payments], []);
  assert.deepEqual([...COMMAND_FIELDS.set_pips_payments], ['usd_per_day']);   // the count `limit` is retired (13 Nov)
  assert.deepEqual([...COMMAND_FIELDS.set_pip_paying], ['pip_id', 'rule']);
  const old = fixture(74);
  await assert.rejects(old.session.pips.read('get_pips_payments', {}), (e) => e instanceof DGCUnsupportedError && /API 75/.test(e.message));
  await assert.rejects(old.session.pips.mutate('set_pips_payments', { usd_per_day: 30 }, { approved: true }), DGCUnsupportedError);
  await assert.rejects(old.session.pips.mutate('set_pip_paying', { pip_id: 'pip_1', rule: 'allow' }, { approved: true }), DGCUnsupportedError);
  assert.equal(old.calls.length, 0);
  const current = fixture(75);
  await assert.rejects(current.session.pips.mutate('set_pip_paying', { pip_id: 'pip_1', rule: 'yes' }, { approved: true }), (e) => e instanceof DGCConfigError && /ask or allow/.test(e.message));
  for (const usd_per_day of [true, '30']) {
    await assert.rejects(current.session.pips.mutate('set_pips_payments', { usd_per_day }, { approved: true }), (e) => e instanceof DGCConfigError && /number of dollars/.test(e.message));
  }
  assert.equal(current.calls.length, 0);
  assert.equal((await current.session.pips.read('get_pips_payments', {})).request.type, 'get_pips_payments');
  assert.equal((await current.session.pips.mutate('set_pips_payments', { usd_per_day: 50 }, { approved: true })).request.usd_per_day, 50);
  assert.equal((await current.session.pips.mutate('set_pip_paying', { pip_id: 'pip_1', rule: 'allow' }, { approved: true })).request.rule, 'allow');
});
