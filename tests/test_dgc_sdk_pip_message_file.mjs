/** Pips API 101 in the TypeScript SDK: get_pip_message_file (a message's file, where it is kept on this computer): a
 *  known read, refused before API 101, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const REQUEST = { pip_id: 'pip_' + 'b'.repeat(32), message_id: 'message_' + 'c'.repeat(32), index: 0 };
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

test('get_pip_message_file: refused before API 101, then read', async () => {
  assert.deepEqual([...COMMAND_FIELDS.get_pip_message_file].sort(), ['index', 'message_id', 'pip_id']);
  const old = fixture(100);
  await assert.rejects(old.session.pips.read('get_pip_message_file', REQUEST),
    (e) => e instanceof DGCUnsupportedError && /101/.test(e.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(101);
  assert.equal((await current.session.pips.read('get_pip_message_file', REQUEST)).request.type, 'get_pip_message_file');
});
