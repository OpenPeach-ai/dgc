/** Pips API 105 in the TypeScript SDK: Your Browser (get_your_browser; set_your_browser_site,
 *  sign_out_your_browser_site, open_your_browser, use_your_browser_view): known with the runtime's fields, refused
 *  before API 105, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const MUTATIONS = {
  set_your_browser_site: { site: 'example.com', mode: 'chosen', pips: ['pip_' + 'b'.repeat(32)] },
  sign_out_your_browser_site: { site: 'example.com' },
  open_your_browser: { url: 'example.com' },
  use_your_browser_view: { op: 'click', x: 10, y: 20 },
};
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

test('Your Browser: the runtime fields, refused before API 105, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.get_your_browser], []);
  assert.deepEqual([...COMMAND_FIELDS.set_your_browser_site].sort(), ['mode', 'pips', 'site']);
  assert.deepEqual([...COMMAND_FIELDS.sign_out_your_browser_site], ['site']);
  assert.deepEqual([...COMMAND_FIELDS.open_your_browser].sort(), ['pip_id', 'url']);
  assert.deepEqual([...COMMAND_FIELDS.use_your_browser_view].sort(), ['dy', 'key', 'op', 'pip_id', 'text', 'url', 'x', 'y']);
  const old = fixture(104);
  await assert.rejects(old.session.pips.read('get_your_browser', {}), (e) => e instanceof DGCUnsupportedError && /API 105/.test(e.message));
  for (const [command, fields] of Object.entries(MUTATIONS)) {
    await assert.rejects(old.session.pips.mutate(command, fields, { approved: true }),
      (e) => e instanceof DGCUnsupportedError && /API 105/.test(e.message));
  }
  assert.equal(old.calls.length, 0);
  const current = fixture(105);
  assert.equal((await current.session.pips.read('get_your_browser', {})).request.type, 'get_your_browser');
  for (const [command, fields] of Object.entries(MUTATIONS)) {
    assert.equal((await current.session.pips.mutate(command, fields, { approved: true })).request.type, command);
  }
});
