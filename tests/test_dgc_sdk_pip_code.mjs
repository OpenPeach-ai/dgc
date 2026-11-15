/** Pips API 98 in the TypeScript SDK: the code card (fill_pip_code): known with the runtime's fields, refused before
 *  API 98, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const REQUEST = { pip_id: 'pip_' + 'b'.repeat(32), action_id: 'compact_' + 'c'.repeat(32), expected_digest: 'd'.repeat(64), code: '482913' };
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

test('the code card: refused before API 98, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.fill_pip_code], ['pip_id', 'action_id', 'expected_digest', 'code']);
  const old = fixture(97);
  await assert.rejects(old.session.pips.mutate('fill_pip_code', REQUEST, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 98/.test(e.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(98);
  assert.equal((await current.session.pips.mutate('fill_pip_code', REQUEST, { approved: true })).request.type, 'fill_pip_code');
});
