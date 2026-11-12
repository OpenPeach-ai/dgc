/** Pips API 88 in the TypeScript SDK: set_pip_profile's `changes.group` and use_pip_computer_view's op `close` are
 *  refused before 88, then sent; start_pip_app_link's `another` is older (0.51, API 74) and still goes
 *  (Python: tests/test_sdk_api88_fields.py). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';

const PIP = 'pip_' + 'a'.repeat(32);
const LINK = 'piplink_' + 'b'.repeat(32);
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
const SENDS = [
  ['set_pip_profile', { pip_id: PIP, changes: { group: 'Home' } }],
  ['use_pip_computer_view', { pip_id: PIP, op: 'close' }],
];

test('refused before API 88, nothing sent', async () => {
  const old = fixture(87);
  for (const [command, values] of SENDS) {
    await assert.rejects(old.session.pips.mutate(command, values, { approved: true }),
      (e) => e instanceof DGCUnsupportedError && /API 88/.test(e.message), command);
  }
  assert.equal(old.calls.length, 0);
});

test('sent from API 88', async () => {
  const now = fixture(88);
  for (const [command, values] of SENDS) {
    const sent = await now.session.pips.mutate(command, values, { approved: true });
    for (const key of Object.keys(values)) assert.deepEqual(sent.request[key], values[key], `${command}.${key}`);
  }
});

test('the same commands without them still go to an older runtime', async () => {
  const old = fixture(87);
  await old.session.pips.mutate('start_pip_app_link', { pip_id: PIP, link_id: LINK }, { approved: true });
  await old.session.pips.mutate('set_pip_profile', { pip_id: PIP, changes: { title: 'Errands' } }, { approved: true });
  await old.session.pips.mutate('use_pip_computer_view', { pip_id: PIP, op: 'frame' }, { approved: true });
  assert.equal(old.calls.length, 3);
});

test("another is older and still reaches a 0.51 runtime", async () => {
  const old = fixture(74);
  const sent = await old.session.pips.mutate('start_pip_app_link', { pip_id: PIP, link_id: LINK, another: true }, { approved: true });
  assert.equal(sent.request.another, true);
});
