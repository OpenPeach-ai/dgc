/** Pips API 53: a Pip's eyes and cursor in the TypeScript SDK. get_pip_eyes / set_pip_eyes, list_pip_computer_frames'
 *  pointers and the live view's "pointer": known, refused before API 53, checked, then sent. Offline wire. */
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

test('how a Pip sees, and where it clicked: refused before API 53, checked, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.get_pip_eyes], ['pip_id']);
  assert.deepEqual([...COMMAND_FIELDS.set_pip_eyes].sort(), ['choice', 'pip_id']);
  assert.ok(COMMAND_FIELDS.list_pip_computer_frames.includes('pointers'));
  const old = fixture(52);
  await assert.rejects(old.session.pips.read('get_pip_eyes', { pip_id: 'pip_a' }), (e) => e instanceof DGCUnsupportedError && /API 53/.test(e.message));
  await assert.rejects(old.session.pips.mutate('set_pip_eyes', { pip_id: 'pip_a', choice: 'relay' }, { approved: true }), DGCUnsupportedError);
  await assert.rejects(old.session.pips.read('list_pip_computer_frames', { run_id: 'run_a', pointers: true }), (e) => e instanceof DGCUnsupportedError && /API 53/.test(e.message));
  await assert.rejects(old.session.pips.mutate('use_pip_computer_view', { pip_id: 'pip_a', op: 'pointer' }, { approved: true }), DGCUnsupportedError);
  assert.equal(old.calls.length, 0);
  await old.session.pips.read('list_pip_computer_frames', { run_id: 'run_a' });
  assert.equal(old.calls.length, 1, 'what an older runtime knows still works');
  const current = fixture(53);
  await assert.rejects(current.session.pips.mutate('set_pip_eyes', { pip_id: 'pip_a', choice: 'always' }, { approved: true }), DGCConfigError);
  await assert.rejects(current.session.pips.read('list_pip_computer_frames', { run_id: 'run_a', pointers: 'yes' }), DGCConfigError);
  assert.equal(current.calls.length, 0);
  assert.equal((await current.session.pips.read('get_pip_eyes', { pip_id: 'pip_a' })).request.type, 'get_pip_eyes');
  assert.equal((await current.session.pips.mutate('set_pip_eyes', { pip_id: 'pip_a', choice: 'off' }, { approved: true })).request.choice, 'off');
  assert.equal((await current.session.pips.read('list_pip_computer_frames', { run_id: 'run_a', pointers: true })).request.pointers, true);
  assert.equal((await current.session.pips.mutate('use_pip_computer_view', { pip_id: 'pip_a', op: 'pointer' }, { approved: true })).request.op, 'pointer');
});
