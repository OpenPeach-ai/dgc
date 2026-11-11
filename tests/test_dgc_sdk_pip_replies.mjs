/** Pips API 83 in the TypeScript SDK: send_pip_message's optional reply_to (Reply on a Pip's message): known, refused
 *  before API 83, checked, then sent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const PIP = 'pip_' + 'a'.repeat(32), MESSAGE = 'message_' + 'b'.repeat(32);
const SEND = { pip_id: PIP, text: 'The first one', idempotency_key: 'k1' };
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

test('reply_to on send_pip_message: known, refused before API 83, checked, then sent', async () => {
  assert.ok(COMMAND_FIELDS.send_pip_message.includes('reply_to'));
  const old = fixture(82);
  await assert.rejects(old.session.pips.mutate('send_pip_message', { ...SEND, reply_to: MESSAGE }, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 83/.test(e.message));
  assert.equal(old.calls.length, 0);
  await old.session.pips.mutate('send_pip_message', SEND, { approved: true });
  assert.equal('reply_to' in old.calls[0].request, false);
  const now = fixture(83);
  await now.session.pips.mutate('send_pip_message', { ...SEND, reply_to: MESSAGE }, { approved: true });
  assert.equal(now.calls[0].request.reply_to, MESSAGE);
  for (const bad of ['the 9 am one', { id: MESSAGE }]) {
    await assert.rejects(now.session.pips.mutate('send_pip_message', { ...SEND, reply_to: bad }, { approved: true }), (e) => e instanceof DGCConfigError);
  }
});
