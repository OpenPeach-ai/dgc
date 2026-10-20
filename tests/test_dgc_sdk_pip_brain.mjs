/** Pips API 55 in the TypeScript SDK: a Personal Pip on the user's own Claude Code or Codex. A subscription
 *  model_choice is refused before API 55, checked, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';

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
const CODEX = { mode: 'subscription', engine: 'codex' };
const calls = [
  (s, c) => s.pips.mutate('create_pip', { workspace_id: 'ws', name: 'Tees', goal: 'Help', model_choice: c }, { approved: true }),
  (s, c) => s.pips.mutate('propose_pip_update', { pip_id: 'pip_a', expected_version: 1, changes: { model_choice: c }, reason: 'Chosen.' }, { approved: true }),
  (s, c) => s.pips.mutate('revise_pip_setup', { setup_id: 'setup_a', expected_digest: 'a'.repeat(64), model_choice: c }, { approved: true }),
];

test('a subscription for a Pip: refused before API 55, checked, then sent', async () => {
  const old = fixture(54);
  for (const call of calls) await assert.rejects(call(old.session, CODEX), (e) => e instanceof DGCUnsupportedError && /API 55/.test(e.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(55);
  for (const bad of [{ mode: 'subscription', engine: 'kimi' }, { mode: 'subscription', engine: 'codex', model: 'x' }])
    for (const call of calls) await assert.rejects(call(current.session, bad), DGCConfigError);
  assert.equal(current.calls.length, 0);
  const sent = [];
  for (const call of calls) sent.push((await call(current.session, CODEX)).request);
  assert.deepEqual(sent[0].model_choice, CODEX);
  assert.deepEqual(sent[1].changes.model_choice, CODEX);
  assert.deepEqual(sent[2].model_choice, CODEX);
  const native = fixture(54);
  await calls[0](native.session, { mode: 'model', model: 'gpt-oss:20b' });
  assert.equal(native.calls.length, 1, 'a native choice is as before');
});
