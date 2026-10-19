/** Pips API 52: photos and files in a Pip's chat handed over through the spool, and an image read as its kept file. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
function fixture(version, extra = {}) {
  const calls = [];
  const wire = { request: async (payload, response, opts) => {
    calls.push(payload);
    return { type: 'pips_result', request_id: opts.requestId, command: payload.request.type, ok: true, result: { request: payload.request } };
  } };
  return { calls, session: new Session(wire, { capabilities: { pips_supported: true, pips_enabled: true, pips_api_version: version, ...extra } }, init) };
}
const message = { pip_id: 'pip_rook', text: '', idempotency_key: 'k',
  spooled_images: [{ name: 'a'.repeat(32) + '.jpg', media_type: 'image/heic' }],
  spooled_files: [{ name: 'bill.pdf', spool: 'b'.repeat(32) }] };

test('send_pip_message spooled_images and spooled_files: known fields, refused before API 52, checked, then sent', async () => {
  assert.ok(COMMAND_FIELDS.send_pip_message.includes('spooled_images'));
  assert.ok(COMMAND_FIELDS.send_pip_message.includes('spooled_files'));
  assert.ok(COMMAND_FIELDS.get_pip_message_image.includes('as_file'));
  const old = fixture(51);
  await assert.rejects(old.session.pips.mutate('send_pip_message', message, { approved: true }),
    (error) => error instanceof DGCUnsupportedError && /API 52/.test(error.message));
  await assert.rejects(old.session.pips.read('get_pip_message_image', { pip_id: 'pip_rook', message_id: 'm', index: 0, as_file: true }),
    (error) => error instanceof DGCUnsupportedError && /API 52/.test(error.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(52);
  for (const bad of [{ spooled_images: [{ name: '../x.jpg', media_type: 'image/jpeg' }] },
    { spooled_images: [{ name: 'x.jpg', media_type: 'image/svg+xml' }] },
    { spooled_files: [{ name: 'a/b.pdf', spool: 'x' }] }]) {
    await assert.rejects(current.session.pips.mutate('send_pip_message', { ...message, ...bad }, { approved: true }), DGCConfigError);
  }
  assert.equal(current.calls.length, 0);
  const answer = await current.session.pips.mutate('send_pip_message', message, { approved: true });
  assert.deepEqual(answer.request.spooled_images, message.spooled_images);
  assert.deepEqual(answer.request.spooled_files, message.spooled_files);
  const read = await current.session.pips.read('get_pip_message_image', { pip_id: 'pip_rook', message_id: 'm', index: 0, as_file: true });
  assert.equal(read.request.as_file, true);
});

test('spool writes the bytes where the runtime reads them, under a fresh name only you can read', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dgc-spool-'));
  const current = fixture(52, { image_spool: true, image_spool_dir: folder });
  const name = await current.session.pips.spool(new Uint8Array([0xff, 0xd8, 0xff, 1, 2]), { suffix: '.jpg' });
  assert.match(name, /^[0-9a-f]{32}\.jpg$/);
  assert.deepEqual([...readFileSync(join(folder, name))], [0xff, 0xd8, 0xff, 1, 2]);
  assert.equal(statSync(join(folder, name)).mode & 0o777, 0o600);
  await assert.rejects(fixture(51, { image_spool: true, image_spool_dir: folder }).session.pips.spool(new Uint8Array([1])), DGCUnsupportedError);
  await assert.rejects(current.session.pips.spool(new Uint8Array([1]), { suffix: '/x' }), DGCConfigError);
});
