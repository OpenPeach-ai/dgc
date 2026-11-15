/** Pips API 100 in the TypeScript SDK: send_pip_message's `output` (@ outputs in a Pip's chat, as Work's Output menu):
 *  a known field, refused before API 100 and for a kind that isn't one of Work's, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError, DGCConfigError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const REQUEST = { pip_id: 'pip_' + 'b'.repeat(32), text: 'Tide times for Sunday', idempotency_key: 'tides', output: 'page' };
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

test('output: refused before API 100 and for another kind, then sent', async () => {
  assert.ok([...COMMAND_FIELDS.send_pip_message].includes('output'));
  const old = fixture(99);
  await assert.rejects(old.session.pips.mutate('send_pip_message', REQUEST, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 100/.test(e.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(100);
  await assert.rejects(current.session.pips.mutate('send_pip_message', { ...REQUEST, output: 'video' }, { approved: true }),
    (e) => e instanceof DGCConfigError && /output is auto/.test(e.message));
  assert.equal(current.calls.length, 0);
  const sent = await current.session.pips.mutate('send_pip_message', REQUEST, { approved: true });
  assert.equal(sent.request.output, 'page');
});
