/** Pips API 111 in the TypeScript SDK: @ a Pip hands it a job (get_pip_job, list_pip_jobs, start_pip_job,
 *  decline_pip_job): known with the runtime's fields, refused before API 111, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const JOB = 'pipjob_' + 'a'.repeat(32), PIP = 'pip_' + 'b'.repeat(32);
const READS = { get_pip_job: { job_id: JOB }, list_pip_jobs: { pip_id: PIP } };
const MUTATIONS = { start_pip_job: { pip_id: PIP, job_id: JOB }, decline_pip_job: { pip_id: PIP, job_id: JOB } };
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

test('A job a chat handed a Pip: the runtime fields, refused before API 111, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.get_pip_job], ['job_id']);
  assert.deepEqual([...COMMAND_FIELDS.list_pip_jobs], ['pip_id']);
  assert.deepEqual([...COMMAND_FIELDS.start_pip_job].sort(), ['job_id', 'pip_id']);
  assert.deepEqual([...COMMAND_FIELDS.decline_pip_job].sort(), ['job_id', 'pip_id']);
  for (const [command, fields] of [...Object.entries(READS), ...Object.entries(MUTATIONS)]) {
    const send = (s) => command in READS ? s.pips.read(command, fields) : s.pips.mutate(command, fields, { approved: true });
    const old = fixture(110);
    await assert.rejects(send(old.session), (e) => e instanceof DGCUnsupportedError && /API 111/.test(e.message));
    assert.equal(old.calls.length, 0);
    const current = fixture(111);
    assert.equal((await send(current.session)).request.type, command);
  }
});
