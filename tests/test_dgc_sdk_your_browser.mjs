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
  assert.deepEqual([...COMMAND_FIELDS.open_your_browser].sort(), ['editor_bounds', 'pip_id', 'url']);
  assert.deepEqual([...COMMAND_FIELDS.get_your_browser_recent], []);
  assert.deepEqual([...COMMAND_FIELDS.use_your_browser_view].sort(), ['dy', 'events', 'height', 'key', 'op', 'own', 'pip_id', 'seq', 'tab', 'text', 'url', 'width', 'x', 'y']);
  assert.deepEqual([...COMMAND_FIELDS.install_google_chrome], []);
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

test('Your Browser, API 107: the recent links, the editor\'s bounds and frames, refused before 107, then sent', async () => {
  const bounds = { x: 0, y: 0, width: 1200, height: 800, screen: { x: 0, y: 0, width: 2560, height: 1440 } };
  const older = fixture(106);
  await assert.rejects(older.session.pips.read('get_your_browser_recent', {}), (e) => e instanceof DGCUnsupportedError && /API 107/.test(e.message));
  await assert.rejects(older.session.pips.mutate('install_google_chrome', {}, { approved: true }), (e) => e instanceof DGCUnsupportedError && /API 107/.test(e.message));
  await assert.rejects(older.session.pips.mutate('use_your_browser_view', { op: 'input', own: true, events: [{ t: 'text', text: 'hi' }] }, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 107/.test(e.message));
  await assert.rejects(older.session.pips.mutate('open_your_browser', { url: 'example.com', editor_bounds: bounds }, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 107/.test(e.message));
  await assert.rejects(older.session.pips.mutate('use_your_browser_view', { op: 'frame', pip_id: 'pip_' + 'a'.repeat(32) }, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 107/.test(e.message));
  assert.equal(older.calls.length, 0);
  const current = fixture(107);
  assert.equal((await current.session.pips.read('get_your_browser_recent', {})).request.type, 'get_your_browser_recent');
  const sent = await current.session.pips.mutate('open_your_browser', { url: 'example.com', editor_bounds: bounds }, { approved: true });
  assert.deepEqual(sent.request.editor_bounds, bounds);
  assert.equal((await current.session.pips.mutate('use_your_browser_view', { op: 'frame', pip_id: 'pip_' + 'a'.repeat(32) }, { approved: true })).request.op, 'frame');
  const own = await current.session.pips.mutate('use_your_browser_view', { op: 'frame', own: true, seq: 3 }, { approved: true });
  assert.deepEqual([own.request.own, own.request.seq], [true, 3]);
  assert.equal((await current.session.pips.mutate('install_google_chrome', {}, { approved: true })).request.type, 'install_google_chrome');
});
