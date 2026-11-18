/** Pips API 108 in the TypeScript SDK: Save to Library on a picture in a Pip's chat (library_pip_message_image): known
 *  with the runtime's fields, refused before API 108, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const FIELDS = { pip_id: 'pip_' + 'b'.repeat(32), message_id: 'msg_' + 'c'.repeat(32), index: 0, keep: true };
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

test('Save to Library: the runtime fields, refused before API 108, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.library_pip_message_image].sort(), ['index', 'keep', 'message_id', 'pip_id']);
  const old = fixture(107);
  await assert.rejects(old.session.pips.mutate('library_pip_message_image', FIELDS, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 108/.test(e.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(108);
  assert.equal((await current.session.pips.mutate('library_pip_message_image', FIELDS, { approved: true })).request.type,
    'library_pip_message_image');
});
