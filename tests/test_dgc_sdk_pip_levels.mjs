/** Pips API 58 in the TypeScript SDK: how much a Personal Pip asks (get_pip_level, set_pip_level): known, refused before
 *  API 58, its level checked, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const PIP = 'pip_' + 'b'.repeat(32);
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

test('how much a Pip asks: refused before API 58, its level checked, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.get_pip_level], ['pip_id']);
  assert.deepEqual([...COMMAND_FIELDS.set_pip_level], ['pip_id', 'level']);
  const old = fixture(57);
  await assert.rejects(old.session.pips.read('get_pip_level', { pip_id: PIP }), (e) => e instanceof DGCUnsupportedError && /API 58/.test(e.message));
  await assert.rejects(old.session.pips.mutate('set_pip_level', { pip_id: PIP, level: 'full' }, { approved: true }), DGCUnsupportedError);
  assert.equal(old.calls.length, 0);
  const current = fixture(58);
  for (const bad of [{ pip_id: PIP, level: 'yolo' }, { pip_id: PIP }, { pip_id: PIP, level: 'full', why: 'x' }]) {
    await assert.rejects(current.session.pips.mutate('set_pip_level', bad, { approved: true }), DGCConfigError);
  }
  assert.equal(current.calls.length, 0);
  assert.equal((await current.session.pips.read('get_pip_level', { pip_id: PIP })).request.type, 'get_pip_level');
  assert.equal((await current.session.pips.mutate('set_pip_level', { pip_id: PIP, level: 'approve' }, { approved: true })).request.level, 'approve');
});
