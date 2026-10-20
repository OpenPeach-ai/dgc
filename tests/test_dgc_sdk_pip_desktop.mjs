/** Pips API 54 in the TypeScript SDK: a Pip computer's apps (get_pip_computer_apps / set_pip_computer_apps): known,
 *  refused before API 54, checked, then sent. Offline wire. */
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

test('a computer\'s apps: refused before API 54, checked, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.get_pip_computer_apps], []);
  assert.deepEqual([...COMMAND_FIELDS.set_pip_computer_apps], ['choice']);
  const old = fixture(53);
  await assert.rejects(old.session.pips.read('get_pip_computer_apps', {}), (e) => e instanceof DGCUnsupportedError && /API 54/.test(e.message));
  await assert.rejects(old.session.pips.mutate('set_pip_computer_apps', { choice: 'download' }, { approved: true }), DGCUnsupportedError);
  assert.equal(old.calls.length, 0);
  const current = fixture(54);
  await assert.rejects(current.session.pips.mutate('set_pip_computer_apps', { choice: 'always' }, { approved: true }), DGCConfigError);
  assert.equal(current.calls.length, 0);
  assert.equal((await current.session.pips.read('get_pip_computer_apps', {})).request.type, 'get_pip_computer_apps');
  assert.equal((await current.session.pips.mutate('set_pip_computer_apps', { choice: 'not_now' }, { approved: true })).request.choice, 'not_now');
});
