/** Pips API 86 in the TypeScript SDK (pips-17d): each of a Pip's computers has a name. rename_pip_computer, and the
 *  optional number on open_pip_computer and use_pip_computer_view: known, refused before API 86, then sent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError, DGCConfigError } from '../sdk/typescript/src/index.ts';
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

test("a Pip's computers' names: refused before API 86, then sent", async () => {
  assert.deepEqual([...COMMAND_FIELDS.rename_pip_computer], ['pip_id', 'number', 'name']);
  assert.ok(COMMAND_FIELDS.open_pip_computer.includes('number'));
  assert.ok(COMMAND_FIELDS.use_pip_computer_view.includes('number'));
  const old = fixture(85);
  await assert.rejects(old.session.pips.mutate('rename_pip_computer', { pip_id: PIP, number: 1, name: 'Desk' }, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 86/.test(e.message));
  await assert.rejects(old.session.pips.mutate('open_pip_computer', { pip_id: PIP, number: 2 }, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 86/.test(e.message));
  assert.equal(old.calls.length, 0);
  const now = fixture(86);
  const sent = await now.session.pips.mutate('rename_pip_computer', { pip_id: PIP, number: 2, name: 'Studio' }, { approved: true });
  assert.deepEqual([sent.request.number, sent.request.name], [2, 'Studio']);
  for (const bad of [{ number: '2', name: 'x' }, { number: 0, name: 'x' }, { number: 1, name: 'x'.repeat(31) }]) {
    await assert.rejects(now.session.pips.mutate('rename_pip_computer', { pip_id: PIP, ...bad }, { approved: true }), DGCConfigError);
  }
});
