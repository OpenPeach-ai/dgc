/** Pips API 65: what Ask DGC to fix did for a Pip's runs; list_pip_run_fixes reads it. Offline wire. */
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

test('list_pip_run_fixes is a read with its one field, refused before API 65', async () => {
  assert.deepEqual([...COMMAND_FIELDS.list_pip_run_fixes], ['pip_id']);
  const old = fixture(64);
  await assert.rejects(old.session.pips.runFixes('pip_rook'), (error) => error instanceof DGCUnsupportedError && /API 65/.test(error.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(65);
  const answer = await current.session.pips.runFixes('pip_rook');
  assert.deepEqual({ ...answer.request, request_id: undefined }, { type: 'list_pip_run_fixes', pip_id: 'pip_rook', request_id: undefined });
  assert.equal(current.calls.length, 1);
});
