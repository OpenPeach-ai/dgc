/** Pips API 75 in the TypeScript SDK: whether a Pip at Do it all may pay (get_pips_payments / set_pips_payments):
 *  known, refused before API 75, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
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

test('payments at Do it all: refused before API 75, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.get_pips_payments], []);
  assert.deepEqual([...COMMAND_FIELDS.set_pips_payments], ['enabled']);
  const old = fixture(74);
  await assert.rejects(old.session.pips.read('get_pips_payments', {}), (e) => e instanceof DGCUnsupportedError && /API 75/.test(e.message));
  await assert.rejects(old.session.pips.mutate('set_pips_payments', { enabled: true }, { approved: true }), DGCUnsupportedError);
  assert.equal(old.calls.length, 0);
  const current = fixture(75);
  assert.equal((await current.session.pips.read('get_pips_payments', {})).request.type, 'get_pips_payments');
  assert.equal((await current.session.pips.mutate('set_pips_payments', { enabled: false }, { approved: true })).request.enabled, false);
});
