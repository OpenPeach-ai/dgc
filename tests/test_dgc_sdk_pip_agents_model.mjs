/** Pips API 104 in the TypeScript SDK: set_pip_agents's sub-agents model fields (model_choice, thinking, context_size,
 *  fallback): known, refused before API 104, then sent; slots alone as before. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const PIP = 'pip_' + 'b'.repeat(32);
const MODEL = { model_choice: { mode: 'model', model: 'qwen3:8b' }, thinking: 'high', context_size: 131072,
  fallback: { provider: '', model: 'llama3.3:70b' } };
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

test('set_pip_agents: its sub-agents model is refused before API 104, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.set_pip_agents].sort(),
    ['context_size', 'fallback', 'model_choice', 'pip_id', 'slots', 'thinking']);
  for (const [field, value] of Object.entries(MODEL)) {
    const old = fixture(103);
    await assert.rejects(old.session.pips.mutate('set_pip_agents', { pip_id: PIP, [field]: value }, { approved: true }),
      (e) => e instanceof DGCUnsupportedError && /104/.test(e.message), field);
    assert.equal(old.calls.length, 0);
  }
  const current = fixture(104);
  const sent = await current.session.pips.mutate('set_pip_agents', { pip_id: PIP, ...MODEL }, { approved: true });
  assert.equal(sent.request.type, 'set_pip_agents');
  const slots = fixture(97);
  assert.equal((await slots.session.pips.mutate('set_pip_agents', { pip_id: PIP, slots: 4 }, { approved: true })).request.slots, 4);
});
