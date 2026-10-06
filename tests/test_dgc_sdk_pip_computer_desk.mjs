/** SDK: a Pip computer's Files and Terminal need API 43; a file added travels outside the 32 KiB budget. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';

const pip = 'pip_' + 'a'.repeat(32);
const file = 'data:application/pdf;base64,' + 'A'.repeat(1_900_000);
const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
function fixture(version) {
  const calls = [];
  const wire = { request: async (payload, response, opts) => { calls.push(payload);
    return { type: 'pips_result', request_id: opts.requestId, command: payload.request.type, ok: true, result: { request: payload.request } }; } };
  return { calls, session: new Session(wire, { capabilities: { pips_supported: true, pips_api_version: version, pips_enabled: true } }, init) };
}

test('Files and the Terminal need API 43', async () => {
  const old = fixture(42);
  await assert.rejects(old.session.pips.read('list_pip_computer_files', { pip_id: pip, path: '' }), DGCUnsupportedError);
  await assert.rejects(old.session.pips.mutate('run_pip_computer_command', { pip_id: pip, command: 'ls' }, { approved: true }), DGCUnsupportedError);
  assert.equal(old.calls.length, 0);
  const current = fixture(43);
  await current.session.pips.read('list_pip_computer_terminal', { pip_id: pip });
  await current.session.pips.mutate('run_pip_computer_command', { pip_id: pip, command: 'ls' }, { approved: true });
  assert.equal(current.calls.length, 2);
});

test('a file of up to 2 MB is added, and nothing else grows', async () => {
  const current = fixture(43);
  const answer = await current.session.pips.mutate('add_pip_computer_file', { pip_id: pip, path: '', name: 'scan.pdf', data: file }, { approved: true });
  assert.equal(answer.request.data, file);
  for (const params of [{ pip_id: pip, path: '', name: 'x', data: file + 'A'.repeat(1_000_000) },
    { pip_id: pip, path: '', name: 'x', data: 'https://example.com/file' }, { pip_id: pip, path: '', name: 'x'.repeat(40000), data: file }]) {
    await assert.rejects(current.session.pips.mutate('add_pip_computer_file', params, { approved: true }), DGCConfigError);
  }
  await assert.rejects(current.session.pips.mutate('remove_pip_computer_file', { pip_id: pip, path: 'x'.repeat(40000) }, { approved: true }), DGCConfigError);
  assert.equal(current.calls.length, 1);
});
