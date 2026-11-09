/** Pips API 76 in the TypeScript SDK: a Pip's fallback model (provider and model) (get_/set_pips_backup, get_/set_pip_backup): known,
 *  refused before API 76, then sent. Offline wire. */
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

test('a backup model for Pips: refused before API 76, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.set_pips_backup], ['model', 'provider']);
  assert.deepEqual([...COMMAND_FIELDS.set_pip_backup], ['pip_id', 'model', 'provider']);
  const old = fixture(75);
  await assert.rejects(old.session.pips.read('get_pips_backup', {}), (e) => e instanceof DGCUnsupportedError && /API 76/.test(e.message));
  await assert.rejects(old.session.pips.mutate('set_pip_backup', { pip_id: PIP, model: null }, { approved: true }), DGCUnsupportedError);
  assert.equal(old.calls.length, 0);
  const current = fixture(76);
  assert.equal((await current.session.pips.read('get_pip_backup', { pip_id: PIP })).request.type, 'get_pip_backup');
  assert.equal((await current.session.pips.mutate('set_pips_backup', { model: 'qwen3:8b' }, { approved: true })).request.model, 'qwen3:8b');
  const provider = 'provider_' + 'c'.repeat(32);
  assert.equal((await current.session.pips.mutate('set_pip_backup', { pip_id: PIP, model: 'gpt-oss:120b', provider }, { approved: true })).request.provider, provider);
});
