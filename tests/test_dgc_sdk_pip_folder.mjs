/** Pips API 110 in the TypeScript SDK: give a Pip a folder later, and remove its folder (give_pip_folder,
 *  remove_pip_folder): known with the runtime's fields, refused before API 110, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const GIVE = { pip_id: 'pip_' + 'b'.repeat(32), folder: '/home/me/shop', dry_run: true };
const REMOVE = { pip_id: 'pip_' + 'b'.repeat(32) };
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

test('Give it a folder and Remove its folder: the runtime fields, refused before API 110, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.give_pip_folder].sort(), ['dry_run', 'folder', 'pip_id']);
  assert.deepEqual([...COMMAND_FIELDS.remove_pip_folder].sort(), ['dry_run', 'pip_id']);
  for (const [command, fields] of [['give_pip_folder', GIVE], ['remove_pip_folder', REMOVE]]) {
    const old = fixture(109);
    await assert.rejects(old.session.pips.mutate(command, fields, { approved: true }),
      (e) => e instanceof DGCUnsupportedError && /API 110/.test(e.message));
    assert.equal(old.calls.length, 0);
    const current = fixture(110);
    assert.equal((await current.session.pips.mutate(command, fields, { approved: true })).request.type, command);
  }
});
