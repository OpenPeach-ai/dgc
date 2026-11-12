/** Pips API 87 in the TypeScript SDK (pc-background-commands): big files between this computer and a Pip computer's
 *  Files, by path. Known to the SDK, refused before API 87, then sent (DGC itself takes them only from the local user). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const PIP = 'pip_' + 'a'.repeat(32);
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

test("big file copies: refused before API 87, then sent", async () => {
  assert.deepEqual([...COMMAND_FIELDS.copy_pip_computer_file_in], ['pip_id', 'path', 'source']);
  assert.deepEqual([...COMMAND_FIELDS.copy_pip_computer_file_out], ['pip_id', 'path', 'target']);
  const old = fixture(86);
  await assert.rejects(old.session.pips.mutate('copy_pip_computer_file_in', { pip_id: PIP, path: '', source: '/tmp/a.bin' }, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 87/.test(e.message));
  const now = fixture(87);
  const sent = await now.session.pips.mutate('copy_pip_computer_file_out', { pip_id: PIP, path: 'a.bin', target: '/tmp/b.bin' }, { approved: true });
  assert.equal(sent.request.type, 'copy_pip_computer_file_out');
});
