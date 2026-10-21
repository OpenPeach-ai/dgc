/** Pips API 59 in the TypeScript SDK: borrowing your own signed-in Chrome (list_pip_borrows, allow_pip_borrow,
 *  decline_pip_borrow, stop_pip_borrow): known, refused before API 59, the card's id checked, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const PIP = 'pip_' + 'b'.repeat(32), BORROW = 'pipborrow_' + 'c'.repeat(32);
const MUTATIONS = ['allow_pip_borrow', 'decline_pip_borrow', 'stop_pip_borrow'];
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

test('borrowing your Chrome: refused before API 59, the card id checked, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.list_pip_borrows], ['pip_id']);
  for (const command of MUTATIONS) assert.deepEqual([...COMMAND_FIELDS[command]], ['pip_id', 'borrow_id']);
  assert.equal(Object.keys(COMMAND_FIELDS).filter((c) => c.includes('borrow') && c.includes('always')).length, 0, 'no Always allow');
  const old = fixture(58);
  await assert.rejects(old.session.pips.read('list_pip_borrows', { pip_id: PIP }), (e) => e instanceof DGCUnsupportedError && /API 59/.test(e.message));
  for (const command of MUTATIONS) {
    await assert.rejects(old.session.pips.mutate(command, { pip_id: PIP, borrow_id: BORROW }, { approved: true }), DGCUnsupportedError);
  }
  assert.equal(old.calls.length, 0);
  const current = fixture(59);
  for (const bad of [{ pip_id: PIP }, { pip_id: PIP, borrow_id: 'pipborrow_x' }, { pip_id: PIP, borrow_id: BORROW, always: true }]) {
    await assert.rejects(current.session.pips.mutate('allow_pip_borrow', bad, { approved: true }), DGCConfigError);
  }
  assert.equal(current.calls.length, 0);
  assert.equal((await current.session.pips.read('list_pip_borrows', { pip_id: PIP })).request.type, 'list_pip_borrows');
  for (const command of MUTATIONS) {
    assert.equal((await current.session.pips.mutate(command, { pip_id: PIP, borrow_id: BORROW }, { approved: true })).request.borrow_id, BORROW);
  }
});
