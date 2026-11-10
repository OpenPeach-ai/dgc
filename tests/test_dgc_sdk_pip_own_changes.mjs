/** Pips API 77 in the TypeScript SDK: undo_pip_change, Undo on a change a Personal Pip made about itself at once in a
 *  turn the user started: known, refused before API 77, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const PIP = 'pip_' + 'a'.repeat(32), CHANGE = 'own_' + 'b'.repeat(32);
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

test("Undo on a Pip's own change: refused before API 77, then sent", async () => {
  assert.deepEqual([...COMMAND_FIELDS.undo_pip_change], ['pip_id', 'change_id']);
  const old = fixture(76);
  await assert.rejects(old.session.pips.mutate('undo_pip_change', { pip_id: PIP, change_id: CHANGE }, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 77/.test(e.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(77);
  const sent = (await current.session.pips.mutate('undo_pip_change', { pip_id: PIP, change_id: CHANGE }, { approved: true })).request;
  assert.deepEqual([sent.type, sent.change_id], ['undo_pip_change', CHANGE]);
});
