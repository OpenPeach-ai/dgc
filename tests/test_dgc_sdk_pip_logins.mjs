/** Pips API 56 in the TypeScript SDK: saved logins (list_pip_logins, save_pip_login, remove_pip_login,
 *  grant_pip_login): known, refused before API 56, checked without ever repeating the password, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const PASSWORD = 'Nw-Pass-7Qx2-zz91', PIP = 'pip_' + 'b'.repeat(32), LOGIN = 'login_' + '1'.repeat(32);
const SAVE = { pip_id: PIP, site: 'northwind-bank.example', username: 'arjun', password: PASSWORD };
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

test('saved logins: refused before API 56, checked without the password, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.list_pip_logins], ['pip_id']);
  assert.deepEqual([...COMMAND_FIELDS.save_pip_login], ['pip_id', 'site', 'username', 'password', 'totp', 'pips', 'action_id', 'expected_digest']);
  assert.deepEqual([...COMMAND_FIELDS.remove_pip_login], ['login_id']);
  assert.deepEqual([...COMMAND_FIELDS.grant_pip_login], ['login_id', 'pips']);
  const old = fixture(55);
  await assert.rejects(old.session.pips.read('list_pip_logins', { pip_id: PIP }), (e) => e instanceof DGCUnsupportedError && /API 56/.test(e.message));
  await assert.rejects(old.session.pips.mutate('save_pip_login', SAVE, { approved: true }), DGCUnsupportedError);
  await assert.rejects(old.session.pips.mutate('remove_pip_login', { login_id: LOGIN }, { approved: true }), DGCUnsupportedError);
  await assert.rejects(old.session.pips.mutate('grant_pip_login', { login_id: LOGIN, pips: 'all' }, { approved: true }), DGCUnsupportedError);
  assert.equal(old.calls.length, 0);
  const current = fixture(56);
  const { site, ...card } = SAVE;
  for (const bad of [{ ...SAVE, password: '' }, { ...SAVE, pips: 'some' }, card, { ...SAVE, action_id: 'compact_x', expected_digest: 'e' }, { ...SAVE, totp: 7 }]) {
    await assert.rejects(current.session.pips.mutate('save_pip_login', bad, { approved: true }),
      (e) => e instanceof DGCConfigError && !e.message.includes(PASSWORD));
  }
  await assert.rejects(current.session.pips.mutate('grant_pip_login', { login_id: LOGIN, pips: 'everyone' }, { approved: true }), DGCConfigError);
  assert.equal(current.calls.length, 0);
  assert.equal((await current.session.pips.read('list_pip_logins', { pip_id: PIP })).request.type, 'list_pip_logins');
  const sent = await current.session.pips.mutate('save_pip_login', { ...SAVE, totp: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', pips: 'all' }, { approved: true });
  assert.equal(sent.request.password, PASSWORD);
  assert.equal((await current.session.pips.mutate('save_pip_login', { ...card, action_id: 'compact_' + 'd'.repeat(32), expected_digest: 'e'.repeat(64) }, { approved: true })).request.action_id, 'compact_' + 'd'.repeat(32));
  assert.deepEqual((await current.session.pips.mutate('grant_pip_login', { login_id: LOGIN, pips: [PIP] }, { approved: true })).request.pips, [PIP]);
  assert.equal(site, 'northwind-bank.example');
});
