/** Pips API 51: a Pip's runs post in its own chat; list_pip_run_posts reads them. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
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

test('list_pip_run_posts is a read with its fields, refused before API 51', async () => {
  assert.deepEqual([...COMMAND_FIELDS.list_pip_run_posts].sort(), ['before_id', 'limit', 'pip_id']);
  const old = fixture(50);
  await assert.rejects(old.session.pips.runPosts('pip_rook'), (error) => error instanceof DGCUnsupportedError && /API 51/.test(error.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(51);
  const answer = await current.session.pips.runPosts('pip_rook', { beforeId: 'run_' + '1'.repeat(32), limit: 10 });
  assert.deepEqual({ ...answer.request, request_id: undefined }, { type: 'list_pip_run_posts', pip_id: 'pip_rook', before_id: 'run_' + '1'.repeat(32), limit: 10, request_id: undefined });
  assert.equal(current.calls.length, 1);
});
